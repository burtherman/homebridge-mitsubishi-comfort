import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, KumoConfig } from './settings';
import { KumoAPI } from './kumo-api';
import { KumoThermostatAccessory } from './accessory';

export class KumoV3Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly accessoryHandlers: KumoThermostatAccessory[] = [];
  private readonly kumoAPI: KumoAPI;
  private readonly kumoConfig: KumoConfig;
  private readonly sitePollers: Map<string, NodeJS.Timeout> = new Map();
  private readonly siteAccessories: Map<string, KumoThermostatAccessory[]> = new Map();
  private readonly degradedPollInterval: number;
  private isStreamingHealthy: boolean = false;
  private isDegradedMode: boolean = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.kumoConfig = config as unknown as KumoConfig;
    this.log.debug('Initializing platform:', this.config.name);

    const kumoConfig = this.kumoConfig;

    // Validate required configuration
    if (!kumoConfig.username || !kumoConfig.password) {
      this.log.error('Username and password are required in config');
      throw new Error('Missing required configuration');
    }

    // Validate username format (should be an email)
    if (typeof kumoConfig.username !== 'string' || !kumoConfig.username.includes('@')) {
      this.log.error('Username must be a valid email address');
      throw new Error('Invalid username format');
    }

    // Validate password is a non-empty string
    if (typeof kumoConfig.password !== 'string' || kumoConfig.password.trim().length === 0) {
      this.log.error('Password must be a non-empty string');
      throw new Error('Invalid password format');
    }

    // Validate pollInterval if provided
    if (kumoConfig.pollInterval !== undefined) {
      if (typeof kumoConfig.pollInterval !== 'number' || kumoConfig.pollInterval < 5) {
        this.log.error('Poll interval must be a number >= 5 seconds');
        throw new Error('Invalid poll interval');
      }
    }

    // Configure degraded mode polling interval
    this.degradedPollInterval = (kumoConfig.degradedPollInterval || 10) * 1000;
    this.log.debug(`Degraded polling interval: ${this.degradedPollInterval / 1000}s`);

    this.kumoAPI = new KumoAPI(
      kumoConfig.username,
      kumoConfig.password,
      this.log,
      kumoConfig.debug || false,
    );

    // Configure streaming health monitoring
    const healthCheckInterval = kumoConfig.streamingHealthCheckInterval || 30;
    const staleThreshold = kumoConfig.streamingStaleThreshold || 60;
    this.kumoAPI.setStreamingHealthConfig(healthCheckInterval, staleThreshold);

    // Register for streaming health changes
    this.kumoAPI.onStreamingHealthChange((isHealthy: boolean) => {
      this.handleStreamingHealthChange(isHealthy);
    });

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      log.debug('Shutting down platform');
      this.cleanup();
    });
  }

  private cleanup() {
    // Clean up all site pollers
    for (const [siteId, timer] of this.sitePollers) {
      clearInterval(timer);
      this.log.debug(`Stopped site poller for ${siteId}`);
    }
    this.sitePollers.clear();

    // Clean up all accessory handlers
    for (const handler of this.accessoryHandlers) {
      handler.destroy();
    }
    this.accessoryHandlers.length = 0;

    // Clean up API
    this.kumoAPI.destroy();
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    try {
      this.log.info('Starting device discovery');

      // Login to API
      const loginSuccess = await this.kumoAPI.login();
      if (!loginSuccess) {
        this.log.error('Failed to login to Kumo Cloud API');
        return;
      }

      // Get all sites
      const sites = await this.kumoAPI.getSites();
      if (sites.length === 0) {
        this.log.warn('No sites found');
        return;
      }

      this.log.info(`Found ${sites.length} site(s)`);

      const discoveredDevices: Array<{ uuid: string; displayName: string; deviceSerial: string; zoneName: string }> = [];

      // For each site, get zones
      for (const site of sites) {
        this.log.debug(`Fetching zones for site: ${site.name}`);
        const zones = await this.kumoAPI.getZones(site.id);

        for (const zone of zones) {
          if (!zone.isActive) {
            this.log.debug(`Skipping inactive zone: ${zone.name}`);
            continue;
          }

          const deviceSerial = zone.adapter.deviceSerial;
          const displayName = zone.name;

          // Skip hidden devices
          if (this.kumoConfig.excludeDevices?.includes(deviceSerial)) {
            this.log.info(`Hiding device from HomeKit: ${displayName} (${deviceSerial})`);
            continue;
          }

          // Generate unique ID for this device
          const uuid = this.api.hap.uuid.generate(deviceSerial);

          discoveredDevices.push({
            uuid,
            displayName,
            deviceSerial,
            zoneName: zone.name,
          });

          this.log.info(`Discovered device: ${displayName} (${deviceSerial})`);

          // Check if accessory already exists
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

          if (existingAccessory) {
            // Update existing accessory
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
            existingAccessory.context.device = {
              deviceSerial,
              zoneName: zone.name,
              displayName,
              siteId: site.id,
            };

            // Create accessory handler
            const handler = new KumoThermostatAccessory(this, existingAccessory, this.kumoAPI, this.kumoConfig.pollInterval);
            this.accessoryHandlers.push(handler);

            // Update accessory if needed
            this.api.updatePlatformAccessories([existingAccessory]);
          } else {
            // Create new accessory
            this.log.info('Adding new accessory:', displayName);

            const accessory = new this.api.platformAccessory(displayName, uuid);

            accessory.context.device = {
              deviceSerial,
              zoneName: zone.name,
              displayName,
              siteId: site.id,
            };

            // Create accessory handler
            const handler = new KumoThermostatAccessory(this, accessory, this.kumoAPI, this.kumoConfig.pollInterval);
            this.accessoryHandlers.push(handler);

            // Register accessory
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.push(accessory);
          }
        }
      }

      // Remove accessories that were not discovered
      const staleAccessories = this.accessories.filter(
        accessory => !discoveredDevices.find(device => device.uuid === accessory.UUID),
      );

      if (staleAccessories.length > 0) {
        this.log.info(`Removing ${staleAccessories.length} stale accessory(ies)`);
        this.api.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          staleAccessories,
        );
      }

      this.log.info('Device discovery completed');

      // Start streaming for all devices
      const allDeviceSerials = discoveredDevices.map(d => d.deviceSerial);
      if (allDeviceSerials.length > 0) {
        this.log.info('Starting streaming for real-time updates...');
        const streamingStarted = await this.kumoAPI.startStreaming(allDeviceSerials);

        if (streamingStarted) {
          this.log.info('✓ Streaming enabled - devices will update in real-time');
        } else {
          this.log.warn('Streaming failed to start - falling back to polling');
        }

        // Log startup configuration summary
        const healthCheckInterval = this.kumoConfig.streamingHealthCheckInterval || 30;
        const staleThreshold = this.kumoConfig.streamingStaleThreshold || 60;

        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log.info('Mitsubishi Comfort Plugin Configuration');
        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log.info(`Streaming: ${streamingStarted ? 'ENABLED' : 'DISABLED'}`);
        this.log.info(`Polling mode: ${this.kumoConfig.disablePolling ? 'On-demand only' : 'Enabled'}`);
        this.log.info(`Normal poll interval: ${(this.kumoConfig.pollInterval || 30)}s`);
        this.log.info(`Degraded poll interval: ${this.degradedPollInterval / 1000}s`);
        this.log.info(`Health check interval: ${healthCheckInterval}s`);
        this.log.info(`Stale threshold: ${staleThreshold}s`);
        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (streamingStarted) {
          if (this.kumoConfig.disablePolling) {
            this.log.info('Strategy: Streaming primary, polling fallback only');
          } else {
            this.log.info('Strategy: Streaming primary, polling supplemental');
          }
        }
      }

      // Start site-level polling based on configuration and streaming health
      if (!this.kumoConfig.disablePolling) {
        const uniqueSites = new Set(discoveredDevices.map(d =>
          this.accessories.find(a => a.UUID === d.uuid)?.context.device.siteId
        ).filter(Boolean));

        this.log.info(`Initializing pollers for ${uniqueSites.size} site(s)`);

        for (const siteId of uniqueSites) {
          this.startSitePoller(siteId as string);
        }
      } else {
        this.log.info('Polling disabled - will activate only if streaming fails');
      }
    } catch (error) {
      this.log.error('Error during device discovery:', error);
    }
  }

  private startSitePoller(siteId: string) {
    // Don't start if already polling
    if (this.sitePollers.has(siteId)) {
      return;
    }

    // If streaming is healthy and polling is disabled, don't start
    if (this.isStreamingHealthy && this.kumoConfig.disablePolling) {
      this.log.info(`Skipping poller for site ${siteId} (streaming healthy, polling disabled)`);
      return;
    }

    const interval = this.isDegradedMode ? this.degradedPollInterval : (this.kumoConfig.pollInterval || 30) * 1000;
    const intervalSec = interval / 1000;
    const mode = this.isDegradedMode ? 'DEGRADED' : 'NORMAL';

    this.log.info(`Starting ${mode} poller for site ${siteId}: ${intervalSec}s intervals`);

    // Group accessories by site for efficient distribution
    const accessories = this.accessoryHandlers.filter(
      handler => handler.getSiteId() === siteId
    );
    this.siteAccessories.set(siteId, accessories);

    // Do immediate poll
    this.pollSite(siteId);

    // Then poll at regular intervals
    const timer = setInterval(() => {
      this.pollSite(siteId);
    }, interval);

    this.sitePollers.set(siteId, timer);
  }

  private async pollSite(siteId: string) {
    try {
      const mode = this.isDegradedMode ? 'DEGRADED' : 'NORMAL';
      const health = this.isStreamingHealthy ? 'healthy' : 'unhealthy';
      this.log.debug(`[${mode}] Polling site ${siteId} (streaming: ${health})`);

      // Fetch all zones for this site
      const zones = await this.kumoAPI.getZones(siteId);

      // Distribute zone data to each accessory
      const accessories = this.siteAccessories.get(siteId) || [];
      for (const handler of accessories) {
        const zone = zones.find(z => z.adapter.deviceSerial === handler.getDeviceSerial());
        if (zone) {
          handler.updateFromZone(zone);
        } else {
          this.log.warn(`Zone not found for device: ${handler.getDeviceSerial()}`);
        }
      }
    } catch (error) {
      this.log.error(`Error polling site ${siteId}:`, error);
    }
  }

  /**
   * Handle streaming health state changes
   */
  private handleStreamingHealthChange(isHealthy: boolean): void {
    const wasHealthy = this.isStreamingHealthy;
    this.isStreamingHealthy = isHealthy;

    // If streaming became unhealthy, switch to degraded mode
    if (wasHealthy && !isHealthy) {
      this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.log.warn('⚠ STREAMING INTERRUPTED');
      this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.enterDegradedMode();
    }

    // If streaming became healthy, exit degraded mode
    if (!wasHealthy && isHealthy) {
      this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.log.info('✓ STREAMING RESUMED');
      this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.exitDegradedMode();
    }
  }

  /**
   * Enter degraded mode - start/speed up polling
   */
  private enterDegradedMode(): void {
    if (this.isDegradedMode) {
      return; // Already in degraded mode
    }

    this.isDegradedMode = true;

    const intervalSec = this.degradedPollInterval / 1000;
    this.log.warn(`→ Switching to DEGRADED MODE`);
    this.log.warn(`→ Polling activated: ${intervalSec}s intervals`);
    this.log.warn(`→ Updates will continue via API polling`);

    // If polling is disabled, temporarily enable it
    if (this.kumoConfig.disablePolling) {
      this.log.warn('→ Overriding disablePolling setting for fallback');
    }

    // Restart all site pollers with degraded interval
    this.restartAllPollers(this.degradedPollInterval);
  }

  /**
   * Exit degraded mode - stop or slow down polling
   */
  private exitDegradedMode(): void {
    if (!this.isDegradedMode) {
      return; // Not in degraded mode
    }

    this.isDegradedMode = false;

    // If polling was disabled in config, stop all pollers
    if (this.kumoConfig.disablePolling) {
      this.log.info('→ Returning to NORMAL MODE');
      this.log.info('→ Polling halted (streaming active)');
      this.log.info('→ Updates resume via real-time streaming');
      this.stopAllPollers();
    } else {
      // Otherwise restart with normal interval
      const normalInterval = (this.kumoConfig.pollInterval || 30) * 1000;
      const normalSec = normalInterval / 1000;
      this.log.info('→ Returning to NORMAL MODE');
      this.log.info(`→ Polling reduced to ${normalSec}s intervals`);
      this.log.info('→ Primary updates via streaming');
      this.restartAllPollers(normalInterval);
    }
  }

  /**
   * Restart all site pollers with new interval
   */
  private restartAllPollers(intervalMs: number): void {
    const intervalSec = intervalMs / 1000;

    for (const [siteId, timer] of this.sitePollers) {
      clearInterval(timer);

      // Do immediate poll
      this.pollSite(siteId);

      // Start new interval
      const newTimer = setInterval(() => {
        this.pollSite(siteId);
      }, intervalMs);

      this.sitePollers.set(siteId, newTimer);
      this.log.debug(`Poller restarted for site ${siteId}: ${intervalSec}s interval`);
    }

    const siteCount = this.sitePollers.size;
    this.log.info(`✓ ${siteCount} site poller(s) active at ${intervalSec}s intervals`);
  }

  /**
   * Stop all site pollers
   */
  private stopAllPollers(): void {
    for (const [siteId, timer] of this.sitePollers) {
      clearInterval(timer);
      this.log.debug(`Poller stopped for site ${siteId}`);
    }
    this.sitePollers.clear();
    this.log.info('✓ All polling halted');
  }
}
