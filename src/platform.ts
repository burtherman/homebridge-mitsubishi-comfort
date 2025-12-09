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

    this.kumoAPI = new KumoAPI(
      kumoConfig.username,
      kumoConfig.password,
      this.log,
      kumoConfig.debug || false,
    );

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
      }

      // Start site-level polling for all unique sites (as fallback)
      if (!this.kumoConfig.disablePolling) {
        const uniqueSites = new Set(discoveredDevices.map(d =>
          this.accessories.find(a => a.UUID === d.uuid)?.context.device.siteId
        ).filter(Boolean));

        for (const siteId of uniqueSites) {
          this.startSitePoller(siteId as string);
        }
      } else {
        this.log.warn('Polling disabled - relying entirely on streaming for device updates');
        this.log.warn('If streaming disconnects, device status may become stale');
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

    this.log.info(`Starting centralized poller for site: ${siteId}`);

    // Group accessories by site for efficient distribution
    const accessories = this.accessoryHandlers.filter(
      handler => handler.getSiteId() === siteId
    );
    this.siteAccessories.set(siteId, accessories);

    // Do immediate poll
    this.pollSite(siteId);

    // Then poll at regular intervals
    const pollInterval = (this.kumoConfig.pollInterval || 30) * 1000;
    const timer = setInterval(() => {
      this.pollSite(siteId);
    }, pollInterval);

    this.sitePollers.set(siteId, timer);
  }

  private async pollSite(siteId: string) {
    try {
      this.log.debug(`Polling site: ${siteId}`);

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
}
