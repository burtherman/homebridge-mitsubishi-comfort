import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import * as os from 'os';

import * as path from 'path';

import { PLATFORM_NAME, PLUGIN_NAME, KumoConfig } from './settings';
import { KumoAPI } from './kumo-api';
import { loadCredStore, saveCredStore } from './cred-store';
import { KumoThermostatAccessory } from './accessory';
import { LocalKumoClient, discoverDeviceIps, enumerateSubnet, SerialCreds } from './local-api';
import { MirrorController, MirrorStatePersistence } from './mirror';
import { loadMirrorStore, saveMirrorStore } from './mirror-store';

/** How long the initial credential gather waits before falling back to retries. */
const LOCAL_CRED_INITIAL_WAIT_MS = 25000;
/** How often to re-nudge devices that still owe us local credentials. */
const LOCAL_CRED_RETRY_MS = 60000;
/** How long each retry pass waits for a nudged device to answer. */
const LOCAL_CRED_RETRY_WAIT_MS = 10000;

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

  // Local LAN control (opt-in). The client is shared with accessories for
  // local-first command routing; the platform drives discovery + status polling.
  public localClient: LocalKumoClient | null = null;
  private localPollTimer: NodeJS.Timeout | null = null;
  private localSerials: string[] = [];
  private localCredRetryTimer: NodeJS.Timeout | null = null;
  private localCredRetryRunning: boolean = false;
  // serial -> candidate password already handed to discovery (from the disk
  // store OR the legacy v2 API), with how many times. Bounds re-sweeps when a
  // candidate is stale (see fillFromLegacyCreds / fillFromStoredCreds). Shared
  // across both sources on purpose: the same stale password must not get a
  // fresh budget just because it came from a different cache.
  private legacyCredAttempts = new Map<string, { password: string; attempts: number }>();
  private static readonly LEGACY_CRED_MAX_ATTEMPTS = 3;
  // On-disk credential cache (see cred-store.ts). null path = disabled (no
  // storage dir available, e.g. in unit tests with a bare API stub).
  private credStorePath: string | null = null;
  private credStore = new Map<string, SerialCreds & { capturedAt: string }>();

  // Device mirroring (opt-in). Constructed once after discovery when `mirror`
  // config is present; makes one unit follow another.
  private mirror: MirrorController | null = null;
  private mirrorStorePath: string | null = null;
  private mirrorStore = new Map<string, string>();

  // Hysteresis for mode switching - prevents rapid oscillation on flaky connections
  private readonly modeChangeHysteresisMs: number = 10000; // 10 second stability required
  private pendingModeChange: NodeJS.Timeout | null = null;
  private pendingModeHealthy: boolean | null = null;

  // Discovery retry — self-heals from transient startup failures (e.g. DNS/login blips)
  private discoveryRetryTimer: NodeJS.Timeout | null = null;
  private discoveryRetryDelayMs: number = 30000; // grows via backoff, reset on success
  private readonly discoveryRetryBaseMs: number = 30000; // first retry after 30s
  private readonly discoveryRetryMaxMs: number = 300000; // cap backoff at 5 minutes

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
    this.kumoAPI.setStreamingHealthCheckInterval(healthCheckInterval);

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
    // Cancel any pending discovery retry
    if (this.discoveryRetryTimer) {
      clearTimeout(this.discoveryRetryTimer);
      this.discoveryRetryTimer = null;
    }

    // Stop local polling
    if (this.localPollTimer) {
      clearInterval(this.localPollTimer);
      this.localPollTimer = null;
    }

    // Stop the background local-credential retry
    this.stopLocalCredRetry();

    // Tear down mirroring timers
    if (this.mirror) {
      this.mirror.destroy();
      this.mirror = null;
    }

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

  async discoverDevices(): Promise<void> {
    const success = await this.attemptDiscovery();

    if (success) {
      // Discovery succeeded: cancel any pending retry and reset the backoff.
      if (this.discoveryRetryTimer) {
        clearTimeout(this.discoveryRetryTimer);
        this.discoveryRetryTimer = null;
      }
      this.discoveryRetryDelayMs = this.discoveryRetryBaseMs;
      return;
    }

    this.scheduleDiscoveryRetry();
  }

  /**
   * Re-run discovery after a transient failure (e.g. a DNS/login blip at startup).
   * Without this, a single failed login left the plugin idle until a manual restart.
   * Backoff grows 30s -> 5min and then retries indefinitely, so the plugin recovers
   * on its own whenever connectivity returns.
   */
  private scheduleDiscoveryRetry(): void {
    if (this.discoveryRetryTimer) {
      return; // a retry is already queued
    }

    const delaySec = Math.round(this.discoveryRetryDelayMs / 1000);
    this.log.warn(`Device discovery did not complete - retrying in ${delaySec}s`);

    this.discoveryRetryTimer = setTimeout(() => {
      this.discoveryRetryTimer = null;
      this.discoverDevices();
    }, this.discoveryRetryDelayMs);

    this.discoveryRetryDelayMs = Math.min(this.discoveryRetryDelayMs * 2, this.discoveryRetryMaxMs);
  }

  private async attemptDiscovery(): Promise<boolean> {
    try {
      this.log.info('Starting device discovery');

      // Login to API
      const loginSuccess = await this.kumoAPI.login();
      if (!loginSuccess) {
        this.log.error('Failed to login to Kumo Cloud API');
        return false;
      }

      // Get all sites
      const sites = await this.kumoAPI.getSites();
      if (sites.length === 0) {
        this.log.warn('No sites found');
        return false;
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

          // Idempotency: a previous (partial) discovery attempt may have already
          // created a handler for this device. Skip it so retries never double-register.
          if (this.accessoryHandlers.some(handler => handler.getDeviceSerial() === deviceSerial)) {
            this.log.debug(`Handler already initialized for ${deviceSerial}, skipping`);
            continue;
          }

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

      // A transient zones-fetch failure returns no zones, leaving this empty.
      // Treat that as a failure and retry rather than unregistering every cached
      // accessory as "stale".
      if (discoveredDevices.length === 0) {
        this.log.warn('No devices discovered - likely a transient API failure; will retry');
        return false;
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

        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log.info('Mitsubishi Comfort Plugin Configuration');
        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.log.info(`Streaming: ${streamingStarted ? 'ENABLED' : 'DISABLED'}`);
        this.log.info(`Polling mode: ${this.kumoConfig.disablePolling ? 'On-demand only' : 'Enabled'}`);
        this.log.info(`Normal poll interval: ${(this.kumoConfig.pollInterval || 30)}s`);
        this.log.info(`Degraded poll interval: ${this.degradedPollInterval / 1000}s`);
        this.log.info(`Health check interval: ${healthCheckInterval}s`);
        this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (streamingStarted) {
          if (this.kumoConfig.disablePolling) {
            this.log.info('Strategy: Streaming primary, polling fallback only');
          } else {
            this.log.info('Strategy: Streaming primary, polling supplemental');
          }
        }

        // Local LAN control (opt-in). Set up in the background: it waits for the
        // adapter passwords (which arrive via adapter_update after streaming
        // connects), then discovers each unit's IP. Never blocks startup, and
        // cloud streaming stays up as the per-unit fallback.
        if (this.kumoConfig.localControl) {
          this.initLocalControl(allDeviceSerials).catch(err =>
            this.log.error('Local control setup failed:', err));
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

      // Device mirroring (opt-in). Construct once — discovery can retry, so guard
      // on an existing controller to avoid double-registering source listeners.
      if (!this.mirror && this.kumoConfig.mirror && this.kumoConfig.mirror.length > 0) {
        this.initMirrorStore();
        this.mirror = new MirrorController(
          this.log, this.kumoConfig.mirror, this.accessoryHandlers, undefined, this.mirrorPersistence());
        this.log.info(`Device mirroring enabled for ${this.kumoConfig.mirror.length} pair(s)`);
      }

      return true;
    } catch (error) {
      this.log.error('Error during device discovery:', error);
      return false;
    }
  }

  /**
   * Set up local LAN control: wait for the per-device credentials, resolve each
   * unit's IP (manual override or LAN sweep), and start local status polling.
   * Best-effort and per-device — any unit we can't reach locally simply stays on
   * the cloud path. Runs in the background; never blocks discovery.
   */
  private async initLocalControl(serials: string[]): Promise<void> {
    this.log.info('Local control enabled — gathering credentials...');
    this.localClient = new LocalKumoClient(this.log);
    this.localSerials = serials;
    this.initCredStore();

    const creds = await this.gatherLocalCreds(serials, LOCAL_CRED_INITIAL_WAIT_MS);
    if (creds.size > 0) {
      this.log.info(`Local control: credentials for ${creds.size}/${serials.length} device(s)`);
      await this.admitLocalDevices(creds);
    } else {
      this.log.warn('Local control: no credentials obtained yet — staying on cloud for now');
    }

    const localCount = this.countLocalDevices();
    if (localCount > 0) {
      this.log.info(`✓ Local control active for ${localCount}/${serials.length} device(s)`);
      this.startLocalPolling();
    } else {
      this.log.warn('Local control: no devices reachable on the LAN — staying on cloud');
    }

    // Some adapters answer `adapterStatus` slowly (or not at all until they
    // recover from a wedged cloud session), so a fixed startup window silently
    // strands them on the cloud for the life of the process. Keep nudging the
    // stragglers in the background and admit each one the moment its
    // credentials show up.
    this.scheduleLocalCredRetry();
  }

  /**
   * Nudge each device for its `adapter_update` and collect both halves of the
   * local key (password from the socket, cryptoSerial from REST), giving up
   * after `waitMs`. Only returns entries for devices that yielded both.
   */
  private async gatherLocalCreds(serials: string[], waitMs: number): Promise<Map<string, SerialCreds>> {
    for (const serial of serials) {
      this.kumoAPI.requestAdapterStatus(serial);
    }
    const creds = new Map<string, SerialCreds>();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && creds.size < serials.length) {
      for (const serial of serials) {
        if (creds.has(serial)) {
          continue;
        }
        const password = this.kumoAPI.getAdapterPassword(serial);
        if (!password) {
          continue;
        }
        const cryptoSerial = await this.kumoAPI.getDeviceCryptoSerial(serial);
        if (cryptoSerial) {
          creds.set(serial, { password, cryptoSerial });
        }
      }
      if (creds.size < serials.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        for (const serial of serials) {
          if (!creds.has(serial)) {
            this.kumoAPI.requestAdapterStatus(serial);
          }
        }
      }
    }
    // A completed push credential is the freshest possible value — persist it
    // so the next restart doesn't re-run the adapter's delivery lottery
    // (observed: 2.5h to first delivery, or never).
    for (const [serial, c] of creds) {
      this.persistCred(serial, c);
    }
    // Push creds are collected first and always win. Gaps are filled from the
    // disk store (last known-good, survives restarts), then the legacy v2 API
    // (external snapshot). Both are candidates only — the signed discovery
    // probe validates every credential before a device is admitted.
    const missing = serials.filter(s => !creds.has(s));
    if (missing.length > 0) {
      this.fillFromStoredCreds(missing, creds);
    }
    const stillMissing = serials.filter(s => !creds.has(s));
    if (stillMissing.length > 0) {
      await this.fillFromLegacyCreds(stillMissing, creds);
    }
    return creds;
  }

  /**
   * Cross-restart memory for the mirror's edge detection. Absent a storage dir the
   * adapter is null and mirroring keeps its original seed-only startup behavior.
   */
  private initMirrorStore(): void {
    try {
      const dir = this.api?.user?.storagePath?.();
      if (!dir) {
        return;
      }
      this.mirrorStorePath = path.join(dir, 'mitsubishi-comfort-mirror-state.json');
      this.mirrorStore = loadMirrorStore(this.mirrorStorePath, this.log);
    } catch (e) {
      this.log.debug(`Mirror state store unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private mirrorPersistence(): MirrorStatePersistence | null {
    const file = this.mirrorStorePath;
    if (!file) {
      return null;
    }
    return {
      load: (serial: string) => this.mirrorStore.get(serial) ?? null,
      save: (serial: string, sig: string) => {
        if (this.mirrorStore.get(serial) === sig) {
          return;
        }
        this.mirrorStore.set(serial, sig);
        saveMirrorStore(file, this.mirrorStore, this.log);
      },
    };
  }

  private initCredStore(): void {
    try {
      const dir = this.api?.user?.storagePath?.();
      if (!dir) {
        return;
      }
      this.credStorePath = path.join(dir, 'mitsubishi-comfort-local-creds.json');
      this.credStore = loadCredStore(this.credStorePath, this.log);
      if (this.credStore.size > 0) {
        this.log.info(`Local control: credential store holds ${this.credStore.size} device(s)`);
      }
    } catch (e) {
      this.log.debug(`Credential store unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Persist a credential if it's new or changed. Never logs the values. */
  private persistCred(serial: string, c: SerialCreds): void {
    if (!this.credStorePath) {
      return;
    }
    const prev = this.credStore.get(serial);
    if (prev && prev.password === c.password && prev.cryptoSerial === c.cryptoSerial) {
      return;
    }
    this.credStore.set(serial, {
      password: c.password, cryptoSerial: c.cryptoSerial, capturedAt: new Date().toISOString(),
    });
    saveCredStore(this.credStorePath, this.credStore, this.log);
    this.log.info(`[LOCAL] ${serial}: credentials persisted to the local store`);
  }

  /**
   * Fill gaps from the on-disk store — the last credential that either arrived
   * by push or survived probe validation in a previous process. Same candidate
   * semantics and attempt budget as the v2 path: a password that rotated while
   * we were down fails the probe and gets burned after 3 tries.
   */
  private fillFromStoredCreds(missing: string[], creds: Map<string, SerialCreds>): void {
    for (const serial of missing) {
      const candidate = this.credStore.get(serial);
      if (!candidate) {
        continue;
      }
      const prior = this.legacyCredAttempts.get(serial);
      const samePassword = prior?.password === candidate.password;
      if (samePassword && prior!.attempts >= KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS) {
        continue;
      }
      const attempts = samePassword ? prior!.attempts + 1 : 1;
      this.legacyCredAttempts.set(serial, { password: candidate.password, attempts });
      creds.set(serial, { password: candidate.password, cryptoSerial: candidate.cryptoSerial });
      this.log.info(
        `[LOCAL] ${serial}: using stored credentials captured ${candidate.capturedAt} ` +
        `(attempt ${attempts}/${KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS}; the signed discovery probe validates them)`);
    }
  }

  /**
   * Fill credential gaps from the legacy v2 API (see fetchLegacyCredentials for
   * why this exists and why its data may be stale). Downstream validation is the
   * LAN sweep's signed probe: a bad password never matches, so the worst case is
   * identical to having no credential at all. The attempt budget exists because
   * the cred retry fires every minute — an invalid legacy password would
   * otherwise trigger a LAN sweep per cycle forever. Three attempts covers a
   * transiently unreachable adapter; after that the password is burned until the
   * v2 store rotates it.
   */
  private async fillFromLegacyCreds(missing: string[], creds: Map<string, SerialCreds>): Promise<void> {
    let legacy: Map<string, { password: string; cryptoSerial: string }>;
    try {
      legacy = await this.kumoAPI.fetchLegacyCredentials();
    } catch (e) {
      this.log.debug(`Legacy credential fallback unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const serial of missing) {
      const candidate = legacy.get(serial);
      if (!candidate) {
        continue;
      }
      const prior = this.legacyCredAttempts.get(serial);
      const samePassword = prior?.password === candidate.password;
      if (samePassword && prior!.attempts >= KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS) {
        continue;   // burned: this password already failed validation repeatedly
      }
      const attempts = samePassword ? prior!.attempts + 1 : 1;
      this.legacyCredAttempts.set(serial, { password: candidate.password, attempts });
      creds.set(serial, { password: candidate.password, cryptoSerial: candidate.cryptoSerial });
      this.log.info(
        `[LOCAL] ${serial}: socket push never delivered credentials — trying the legacy v2 copy ` +
        `(attempt ${attempts}/${KumoV3Platform.LEGACY_CRED_MAX_ATTEMPTS}; the signed discovery probe validates it)`);
    }
  }

  /**
   * Resolve each credentialed device's IP (configured override first, then a LAN
   * sweep for the rest) and hand it to the local client.
   */
  private async admitLocalDevices(creds: Map<string, SerialCreds>): Promise<void> {
    if (!this.localClient) {
      return;
    }
    const manual = this.kumoConfig.localControlIps || {};
    const toDiscover = new Map<string, SerialCreds>();
    for (const [serial, c] of creds) {
      if (manual[serial]) {
        this.localClient.setCreds(serial, { ...c, ip: manual[serial] });
        this.log.info(`Local control: ${serial} -> ${manual[serial]} (configured)`);
      } else {
        toDiscover.set(serial, c);
      }
    }
    if (toDiscover.size === 0) {
      return;
    }
    const hostIp = this.getHostIpv4();
    if (!hostIp) {
      this.log.warn('Local control: could not determine the host LAN subnet for discovery');
      return;
    }
    const candidates = enumerateSubnet(hostIp);
    this.log.info(`Local control: sweeping ${candidates.length} addresses on ${hostIp}'s subnet...`);
    const ips = await discoverDeviceIps(this.log, candidates, toDiscover);
    for (const [serial, ip] of ips) {
      const c = toDiscover.get(serial)!;
      this.localClient.setCreds(serial, { ...c, ip });
      // The probe just proved this credential against the real adapter — persist
      // it. This is what captures v2-sourced creds: they enter as unvalidated
      // candidates, and only the validated ones reach the store.
      this.persistCred(serial, c);
    }
  }

  private countLocalDevices(): number {
    if (!this.localClient) {
      return 0;
    }
    return this.localSerials.filter(serial => this.localClient!.hasLocal(serial)).length;
  }

  private pendingLocalSerials(): string[] {
    if (!this.localClient) {
      return [];
    }
    return this.localSerials.filter(serial => !this.localClient!.hasLocal(serial));
  }

  /**
   * Background retry for devices that haven't yielded local credentials yet.
   * A nudge is a single socket emit, so retrying costs nothing; the expensive
   * part (the LAN sweep) only runs when a device actually hands over its
   * credentials. Stops once every device is local.
   */
  private scheduleLocalCredRetry(): void {
    if (this.localCredRetryTimer || this.pendingLocalSerials().length === 0) {
      return;
    }
    this.localCredRetryTimer = setInterval(() => {
      void this.retryLocalCreds();
    }, LOCAL_CRED_RETRY_MS);
  }

  private async retryLocalCreds(): Promise<void> {
    // A sweep can outlast the interval; never let two passes overlap.
    if (this.localCredRetryRunning || !this.localClient) {
      return;
    }
    const pending = this.pendingLocalSerials();
    if (pending.length === 0) {
      this.stopLocalCredRetry();
      return;
    }
    this.localCredRetryRunning = true;
    try {
      const creds = await this.gatherLocalCreds(pending, LOCAL_CRED_RETRY_WAIT_MS);
      if (creds.size === 0) {
        this.log.debug(`Local control: still waiting on ${pending.length} device(s)`);
        return;
      }
      this.log.info(`Local control: credentials arrived for ${creds.size} more device(s)`);
      await this.admitLocalDevices(creds);
      const localCount = this.countLocalDevices();
      if (localCount > 0) {
        this.log.info(`✓ Local control active for ${localCount}/${this.localSerials.length} device(s)`);
        // No-op if it's already running.
        this.startLocalPolling();
      }
      if (this.pendingLocalSerials().length === 0) {
        this.stopLocalCredRetry();
      }
    } catch (error) {
      this.log.debug(`Local control retry failed: ${(error as Error).message}`);
    } finally {
      this.localCredRetryRunning = false;
    }
  }

  private stopLocalCredRetry(): void {
    if (this.localCredRetryTimer) {
      clearInterval(this.localCredRetryTimer);
      this.localCredRetryTimer = null;
    }
  }

  /** Find the host's primary private-LAN IPv4 (to derive the sweep subnet). */
  private getHostIpv4(): string | null {
    const ifaces = os.networkInterfaces();
    let fallback: string | null = null;
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family !== 'IPv4' || ni.internal || ni.address.startsWith('169.254.')) {
          continue;
        }
        // Prefer a private-LAN address (10/8, 192.168/16, 172.16/12) over e.g. a
        // CGNAT/VPN range like Tailscale's 100.64/10.
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) {
          return ni.address;
        }
        fallback = fallback || ni.address;
      }
    }
    return fallback;
  }

  /** Poll the locally-reachable units and feed their status into the accessories. */
  private startLocalPolling(): void {
    if (this.localPollTimer) {
      return;
    }
    const interval = (this.kumoConfig.localPollInterval || 15) * 1000;
    this.log.info(`Local status polling every ${interval / 1000}s`);

    const poll = async () => {
      if (!this.localClient) {
        return;
      }
      for (const handler of this.accessoryHandlers) {
        const serial = handler.getDeviceSerial();
        if (!this.localClient.hasLocal(serial)) {
          continue;
        }
        try {
          const status = await this.localClient.getStatus(serial);
          if (status) {
            handler.updateFromLocal(status);
          }
        } catch (error) {
          this.log.debug(`Local poll error for ${serial}: ${(error as Error).message}`);
        }
      }
    };

    poll();
    this.localPollTimer = setInterval(poll, interval);
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
   * Handle streaming health state changes with hysteresis
   *
   * Hysteresis prevents rapid mode switching on flaky connections:
   * - Entering degraded mode: IMMEDIATE (we need polling fallback right away)
   * - Exiting degraded mode: DELAYED (wait for stable connection before stopping polling)
   */
  private handleStreamingHealthChange(isHealthy: boolean): void {
    const wasHealthy = this.isStreamingHealthy;
    this.isStreamingHealthy = isHealthy;

    // If streaming became unhealthy, switch to degraded mode IMMEDIATELY
    // (No hysteresis - we need polling fallback right away)
    if (wasHealthy && !isHealthy) {
      // Cancel any pending mode change (e.g., pending exit from degraded mode)
      if (this.pendingModeChange) {
        clearTimeout(this.pendingModeChange);
        this.pendingModeChange = null;
        this.pendingModeHealthy = null;
        this.log.debug('Cancelled pending mode change due to new disconnect');
      }

      this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.log.warn('⚠ STREAMING INTERRUPTED');
      this.log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.enterDegradedMode();
    }

    // If streaming became healthy, schedule exit from degraded mode WITH HYSTERESIS
    // (Wait for stable connection before stopping polling fallback)
    if (!wasHealthy && isHealthy) {
      // If already pending the same mode change, do nothing
      if (this.pendingModeHealthy === true) {
        this.log.debug('Mode change to healthy already pending, waiting for stability...');
        return;
      }

      // Cancel any conflicting pending mode change
      if (this.pendingModeChange) {
        clearTimeout(this.pendingModeChange);
      }

      this.pendingModeHealthy = true;
      const hysteresisSec = this.modeChangeHysteresisMs / 1000;
      this.log.info(`Streaming reconnected - waiting ${hysteresisSec}s for stable connection...`);

      this.pendingModeChange = setTimeout(() => {
        this.pendingModeChange = null;
        this.pendingModeHealthy = null;

        // Double-check health is still good before switching
        if (this.isStreamingHealthy) {
          this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.log.info('✓ STREAMING RESUMED (stable)');
          this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          this.exitDegradedMode();
        } else {
          this.log.warn('Streaming became unhealthy during stability check, staying in degraded mode');
        }
      }, this.modeChangeHysteresisMs);
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
