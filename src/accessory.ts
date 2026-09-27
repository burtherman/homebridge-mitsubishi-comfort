import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { KumoV3Platform } from './platform';
import { KumoAPI } from './kumo-api';
import { POLL_INTERVAL, DeviceStatus, DeviceProfile, Zone, Commands, MirrorState } from './settings';
import { cToF, quantizeSetpointInRange } from './temperature';

// HeaterCooler implementation (2.0): portions derived from
// homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0, src/accessory.ts @ 83dfd18),
// modified. See NOTICE and docs/superpowers/specs/2026-09-27-heatercooler-port-plan.md.

/**
 * Where a command we sent came from. Logged with every send so "who changed this
 * unit?" is answerable from the log alone.
 */
export type CommandOrigin =
  | 'homekit:active'
  | 'homekit:mode'
  | 'homekit:threshold'
  | 'homekit:fan-switch'
  | 'homekit:dry-switch'
  | 'mirror';

type ActiveMode = 'heat' | 'cool' | 'auto' | 'dry' | 'vent';
type SetpointField = 'spHeat' | 'spCool';

/**
 * Collapse power + operationMode into the one label that matters for "is it on,
 * and doing what". power=0 is off whatever the mode field says.
 */
function powerModeLabel(s: { power?: number; operationMode?: string } | null): string {
  if (!s) {
    return 'unknown';
  }
  return s.power === 0 ? 'off' : (s.operationMode || 'unknown');
}

export class KumoThermostatAccessory {
  private service: Service;
  private pollTimer: NodeJS.Timeout | null = null;

  private deviceSerial: string;
  private siteId: string;
  private currentStatus: DeviceStatus | null = null;
  private pollIntervalMs: number;
  private hasHumiditySensor: boolean = false;
  private lastUpdateTimestamp: number = 0;
  private lastUpdateSource: 'streaming' | 'polling' | 'local' | 'none' = 'none';
  private lastLocalUpdateTs: number = 0;
  // While a local poll has arrived within this window, local is the authoritative
  // status source and cloud updates are dropped (the cloud lags ~7-10s and would
  // otherwise clobber fresher local data). Should exceed the local poll interval.
  private readonly LOCAL_AUTHORITATIVE_MS = 45000;
  // Cloud-reported adapter reachability from `device_status_v2`. null = nothing
  // reported yet (treated as reachable). See setCloudConnected.
  private cloudConnected: boolean | null = null;
  private hasReceivedValidUpdate: boolean = false;
  private deviceProfile: DeviceProfile | null = null;
  // Last temperature range we logged, so a profile_update heartbeat (arrives every
  // ~15 min and almost never changes the range) doesn't repeat the same info line.
  private lastLoggedRange: string | null = null;
  private filterMaintenanceService: Service | null = null;
  private fanOnlyService: Service | null = null;
  private dryService: Service | null = null;
  private humidityService: Service | null = null;
  private modelNumberSet: boolean = false;

  // Power and mode writes arriving in one HomeKit request, combined into one command.
  // hap-nodejs dispatches every handler in a write request concurrently without
  // awaiting any of them, so a scene's Active=1 and TargetHeaterCoolerState=COOL
  // land in arbitrary order. Sent separately, the power-on picked a mode of its own
  // and raced the explicit one. Buffering to the next tick makes the burst one
  // intent. See queuePowerMode.
  private pendingPowerMode: { active?: boolean; mode?: 'heat' | 'cool' | 'auto' } | null = null;
  private powerModeFlush: Promise<void> | null = null;
  // Setpoints HomeKit wrote while the unit was off, which can't be sent on their own
  // (the API 400s a bare setpoint on an off unit). A scene that turns a unit on with
  // "cool, 72" delivers the 72 while the unit is still off; if it arrived in the same
  // burst as the power-on it rides along in that command. Anything older is left
  // out: an "AC off" scene re-sends stale captured setpoints, and applying those at
  // the next power-on is the 1.8.2 bug.
  private readonly setpointsCachedWhileOff: Map<SetpointField, { value: number; at: number }> = new Map();
  private readonly SAME_BURST_MS = 1000;
  // Timestamp (ms) of the most recent HomeKit "off" request. Within
  // OFF_SUPPRESS_WINDOW_MS of it, setpoint writes are suppressed (cached + echoed
  // but not sent). An "AC off" scene captures each unit's full state and
  // re-pushes its setpoints (the two threshold handles) and mode alongside
  // Active=0; HomeKit dispatches them concurrently in an
  // arbitrary order. A setpoint landing after the off reaches the LAN adapter as
  // a bare, mode-less write (local commands carry no power field — see
  // local-api.ts) and powers the unit back on. The unit is being turned off —
  // there is nothing to set. Set synchronously before the off command's await so
  // sibling handlers in the same burst observe it; any active mode clears it.
  private offRequestedAt = 0;
  private readonly OFF_SUPPRESS_WINDOW_MS = 4000;
  // Origin, resulting power/mode label and time of the last command we sent, so an
  // observed state change can be attributed to us instead of reported as external.
  // Attribution requires BOTH a recent send and a matching resulting label — a
  // window alone would swallow a genuine external change that lands right after
  // one of our commands, which is exactly the event this logging exists to catch.
  private lastCommandOrigin: CommandOrigin | null = null;
  private lastCommandLabel: string | null = null;
  private lastCommandAt = 0;
  private readonly ATTRIBUTION_MS = 60000;

  // The off-suppression window above only catches setpoints dispatched *after*
  // the off. A scene's captured setpoint that lands just *before* it arrives
  // while the unit is still on, so it sends — and permanently rewrites the
  // stored setpoint. Observed live 2026-07-26: an "AC off" scene rewrote the
  // Living room's spCool to its stale captured 25°C, leaving a mirror target
  // 2.5°C off its source (mirroring is edge-triggered, so nothing corrected it
  // until the source next changed). Holding each setpoint write briefly closes
  // the gap in the other direction: an off landing during the hold cancels the
  // pending send. Keyed per setpoint so the two AUTO handles don't cancel each
  // other, with a generation counter so a drag only sends its final value.
  private readonly setpointWriteGen: Map<string, number> = new Map();
  private readonly SETPOINT_HOLD_MS = 1500;

  // Listeners notified whenever this accessory's state actually changes. The
  // MirrorController subscribes to a *source* accessory here so it can push the
  // change to its target(s). Fired from processZoneUpdate (catches wall
  // thermostat / Kumo app / any observed change) and from the setters (catches a
  // HomeKit change to this unit without waiting for the streaming/local echo).
  private statusListeners: Array<(status: DeviceStatus) => void> = [];

  constructor(
    private readonly platform: KumoV3Platform,
    private readonly accessory: PlatformAccessory,
    private readonly kumoAPI: KumoAPI,
    pollIntervalSeconds?: number,
  ) {
    this.deviceSerial = this.accessory.context.device.deviceSerial;
    this.siteId = this.accessory.context.device.siteId;
    this.pollIntervalMs = (pollIntervalSeconds || POLL_INTERVAL / 1000) * 1000;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Mitsubishi')
      .setCharacteristic(this.platform.Characteristic.Model, 'Kumo Cloud Heat Pump')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceSerial);

    // A ductless mini-split is a HeaterCooler, not a Thermostat: power (`Active`) is
    // separate from the heat/cool/auto mode, and the current state has a real IDLE.
    // Accessories cached by 1.x carry a Thermostat service. Remove it, or the unit
    // shows two competing climate tiles. HomeKit automations bound to the old
    // thermostat controls stop working and must be recreated (the Dry/Fan switches
    // keep their subtypes, so automations on those survive).
    const staleThermostat = this.accessory.getService(this.platform.Service.Thermostat);
    if (staleThermostat) {
      this.accessory.removeService(staleThermostat);
      this.platform.log.info(
        `${accessory.context.device.displayName}: migrated Thermostat -> HeaterCooler. ` +
        'HomeKit automations and scenes that controlled this thermostat must be recreated.',
      );
    }

    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.displayName,
    );

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentHeaterCoolerState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.getTargetHeaterCoolerState.bind(this))
      .onSet(this.setTargetHeaterCoolerState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // On HeaterCooler the two thresholds ARE the setpoint controls in every mode:
    // the Home app shows the heating threshold in HEAT, the cooling threshold in COOL
    // and both as a range in AUTO. HeatingThreshold = spHeat, CoolingThreshold =
    // spCool (these units report spAuto: null and use the band for auto). There's no
    // TargetTemperature writing both from one value, so a scene can't collapse the
    // AUTO band. minStep 0.1 because writes are snapped to the whole-°F grid (see
    // quantize and src/temperature.ts); HAP applies minStep only outbound.
    this.setThresholdRange('spHeat', 10, 35);
    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onGet(this.getHeatingThresholdTemperature.bind(this))
      .onSet(this.setHeatingThresholdTemperature.bind(this));

    this.setThresholdRange('spCool', 10, 35);
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onGet(this.getCoolingThresholdTemperature.bind(this))
      .onSet(this.setCoolingThresholdTemperature.bind(this));

    // Note: Polling is now handled at the platform level (centralized site polling)
    // This accessory will receive updates via updateFromZone()

    // If this accessory was cached with a fan-only switch from a previous run,
    // wire up its handlers immediately. applyDeviceProfile() will remove it if
    // the device profile later reports hasModeVent === false.
    const cachedFanSwitch = this.accessory.getServiceById(
      this.platform.Service.Switch,
      'fan-only',
    );
    if (cachedFanSwitch) {
      this.fanOnlyService = cachedFanSwitch;
      this.fanOnlyService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getFanOnlyOn.bind(this))
        .onSet(this.setFanOnlyOn.bind(this));
    }

    // Same for a cached dry switch (see setupDrySwitch / hasModeDry).
    const cachedDrySwitch = this.accessory.getServiceById(
      this.platform.Service.Switch,
      'dry',
    );
    if (cachedDrySwitch) {
      this.dryService = cachedDrySwitch;
      this.dryService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getDryOn.bind(this))
        .onSet(this.setDryOn.bind(this));
    }

    // A cached HumiditySensor needs its handler now, not when the first humidity
    // reading arrives, or HomeKit reads a default until then.
    const cachedHumidity = this.accessory.getService(this.platform.Service.HumiditySensor);
    if (cachedHumidity) {
      if (this.platform.kumoConfig?.showHumiditySensor === false) {
        this.accessory.removeService(cachedHumidity);
      } else {
        this.hasHumiditySensor = true;
        this.setupHumidityService();
      }
    }

    // Register for streaming updates
    this.kumoAPI.subscribeToDevice(this.deviceSerial, this.handleStreamingUpdate.bind(this));
    this.platform.log.debug(`Registered streaming callback for ${this.deviceSerial}`);

    // Register for profile updates (setpoint limits)
    this.kumoAPI.onDeviceProfileUpdate((serial, profile) => {
      if (serial === this.deviceSerial) {
        this.applyDeviceProfile(profile);
      }
    });

  }

  private applyDeviceProfile(profile: DeviceProfile): void {
    this.deviceProfile = profile;

    // Each threshold gets the range of the mode it drives, widened to the auto range
    // because both are live in AUTO. 1.x applied one range (the union of all modes)
    // to every setpoint, so COOL offered values from the HEAT range and the unit
    // answered `invalidSpCoolRange`. These limits are installer settings in the unit,
    // reported read-only; the cloud enforces them independently.
    const { heatMin, heatMax, coolMin, coolMax } = this.setpointRanges(profile);
    this.setThresholdRange('spHeat', heatMin, heatMax);
    this.setThresholdRange('spCool', coolMin, coolMax);

    // Only log when the range actually changes. profile_update is a ~15-min
    // heartbeat carrying the same limits every time; logging it each tick just
    // fills the log (observed: 5 units × 4/hr = a wall of identical lines).
    const rangeKey = `${heatMin}-${heatMax}/${coolMin}-${coolMax}`;
    if (rangeKey !== this.lastLoggedRange) {
      this.lastLoggedRange = rangeKey;
      this.platform.log.info(
        `${this.accessory.displayName}: setpoint range heat ${heatMin}-${heatMax}°C ` +
        `(${cToF(heatMin).toFixed(0)}-${cToF(heatMax).toFixed(0)}°F), ` +
        `cool ${coolMin}-${coolMax}°C (${cToF(coolMin).toFixed(0)}-${cToF(coolMax).toFixed(0)}°F)`,
      );
    }

    // Offer only the modes the unit can do. AUTO needs both directions.
    const T = this.platform.Characteristic.TargetHeaterCoolerState;
    const modes: number[] = profile.hasModeHeat ? [T.AUTO, T.HEAT, T.COOL] : [T.COOL];
    this.service.getCharacteristic(T).setProps({ validValues: modes });

    // Dry and fan-only have no HeaterCooler mode, so each stays a Switch on units
    // that support it. Shown by default (hide via config): they're the only
    // controls whose HomeKit automations survive the move from Thermostat.
    if (profile.hasModeVent && this.platform.kumoConfig?.showFanOnlySwitch !== false) {
      this.setupFanOnlySwitch();
    } else {
      this.removeFanOnlySwitch();
    }

    if (profile.hasModeDry && this.platform.kumoConfig?.showDrySwitch !== false) {
      this.setupDrySwitch();
    } else {
      this.removeDrySwitch();
    }
  }

  /**
   * Set a threshold's range, first moving its current value inside it. HAP starts
   * the characteristics at its own default (0 for the heating threshold) and warns
   * whenever a range excludes the current value.
   */
  private setThresholdRange(field: SetpointField, min: number, max: number): void {
    const C = this.platform.Characteristic;
    const char = field === 'spHeat' ? C.HeatingThresholdTemperature : C.CoolingThresholdTemperature;
    const current = this.service.getCharacteristic(char).value;
    if (typeof current !== 'number' || current < min || current > max) {
      const fallback = field === 'spHeat' ? 20 : 24;
      const inside = typeof current === 'number' ? Math.min(Math.max(current, min), max) : fallback;
      this.service.updateCharacteristic(char, inside);
    }
    this.service.getCharacteristic(char).setProps({ minValue: min, maxValue: max, minStep: 0.1 });
  }

  /** Per-threshold setpoint limits: each mode's own range, widened to the auto range. */
  private setpointRanges(profile: DeviceProfile | null): {
    heatMin: number; heatMax: number; coolMin: number; coolMax: number;
  } {
    if (!profile) {
      return { heatMin: 10, heatMax: 35, coolMin: 10, coolMax: 35 };
    }
    return {
      heatMin: Math.min(profile.minimumSetPoints.heat, profile.minimumSetPoints.auto),
      heatMax: Math.max(profile.maximumSetPoints.heat, profile.maximumSetPoints.auto),
      coolMin: Math.min(profile.minimumSetPoints.cool, profile.minimumSetPoints.auto),
      coolMax: Math.max(profile.maximumSetPoints.cool, profile.maximumSetPoints.auto),
    };
  }

  /**
   * Re-publish this accessory to the bridge. REQUIRED after adding or removing a
   * service or characteristic at runtime: the accessory was already published to
   * HomeKit during discovery, so structural changes that happen later (a
   * capability switch, the humidity characteristic, the filter service) never
   * reach the Home app — or get persisted to the cache — without this call.
   */
  private publishStructureChange(): void {
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private setupFanOnlySwitch(): void {
    if (this.fanOnlyService) {
      return;
    }

    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'fan-only');
    const displayName = this.accessory.context.device.displayName;
    const switchName = `${displayName} Fan`;

    this.fanOnlyService =
      existing ||
      this.accessory.addService(this.platform.Service.Switch, switchName, 'fan-only');

    this.fanOnlyService.setCharacteristic(this.platform.Characteristic.Name, switchName);
    this.fanOnlyService.setCharacteristic(this.platform.Characteristic.ConfiguredName, switchName);

    this.fanOnlyService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getFanOnlyOn.bind(this))
      .onSet(this.setFanOnlyOn.bind(this));

    // Reflect current state immediately if we already have a status
    this.fanOnlyService.updateCharacteristic(
      this.platform.Characteristic.On,
      this.isFanOnlyActive(this.currentStatus),
    );

    // The profile arrives via an async streaming event, after the accessory
    // has already been published to the bridge. A service added now is invisible
    // to HomeKit (and not persisted) unless we re-publish the accessory.
    if (!existing) {
      this.publishStructureChange();
    }

    this.platform.log.debug(`Added Fan-Only switch for ${this.accessory.displayName}`);
  }

  private removeFanOnlySwitch(): void {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'fan-only');
    if (existing) {
      this.accessory.removeService(existing);
      this.publishStructureChange();
      this.platform.log.debug(
        `Removed Fan-Only switch for ${this.accessory.displayName} (device reports no vent mode support)`,
      );
    }
    this.fanOnlyService = null;
  }

  private isFanOnlyActive(status: DeviceStatus | null): boolean {
    if (!status) {
      return false;
    }
    return status.power === 1 && status.operationMode === 'vent';
  }

  async getFanOnlyOn(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.isFanOnlyActive(this.currentStatus);
  }

  async setFanOnlyOn(value: CharacteristicValue): Promise<void> {
    this.assertReachable();
    const on = value as boolean;
    const operationMode: 'vent' | 'off' = on ? 'vent' : 'off';
    const power: 0 | 1 = on ? 1 : 0;

    this.platform.log.info(
      `[FAN ONLY] ${this.accessory.displayName}: HomeKit sent ${on ? 'ON' : 'OFF'}`,
    );

    this.noteModeIntent(operationMode);

    const success = await this.sendDeviceCommand({ operationMode, power }, 'homekit:fan-switch');

    if (!success) {
      this.platform.log.error(
        `[FAN ONLY] ${this.accessory.displayName}: Failed to set fan-only ${on ? 'ON' : 'OFF'}`,
      );
      // Revert the switch to the actual device state
      setTimeout(() => {
        this.fanOnlyService?.updateCharacteristic(
          this.platform.Characteristic.On,
          this.isFanOnlyActive(this.currentStatus),
        );
      }, 100);
      return;
    }

    this.platform.log.info(`[FAN ONLY] ${this.accessory.displayName}: Command accepted by API`);

    // Optimistic local-state update so the climate tile reflects the change now.
    if (this.currentStatus) {
      this.currentStatus.operationMode = operationMode;
      this.currentStatus.power = on ? 1 : 0;
      this.rememberActiveMode(this.currentStatus);
      this.refreshClimateCharacteristics();
    }

    // Fan-only and dry are mutually exclusive — engaging fan-only means the
    // unit is no longer dehumidifying, so flip the dry switch off optimistically.
    if (this.dryService) {
      this.dryService.updateCharacteristic(this.platform.Characteristic.On, false);
    }

    // Mirror a HomeKit-driven fan-only toggle to any followers immediately.
    this.notifyStatusListeners();
  }

  private setupDrySwitch(): void {
    if (this.dryService) {
      return;
    }

    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'dry');
    const displayName = this.accessory.context.device.displayName;
    const switchName = `${displayName} Dry`;

    this.dryService =
      existing ||
      this.accessory.addService(this.platform.Service.Switch, switchName, 'dry');

    this.dryService.setCharacteristic(this.platform.Characteristic.Name, switchName);
    this.dryService.setCharacteristic(this.platform.Characteristic.ConfiguredName, switchName);

    this.dryService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getDryOn.bind(this))
      .onSet(this.setDryOn.bind(this));

    // Reflect current state immediately if we already have a status
    this.dryService.updateCharacteristic(
      this.platform.Characteristic.On,
      this.isDryActive(this.currentStatus),
    );

    // The profile arrives via an async streaming event, after the accessory
    // has already been published to the bridge. A service added now is invisible
    // to HomeKit (and not persisted) unless we re-publish the accessory.
    if (!existing) {
      this.publishStructureChange();
    }

    this.platform.log.debug(`Added Dry switch for ${this.accessory.displayName}`);
  }

  private removeDrySwitch(): void {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'dry');
    if (existing) {
      this.accessory.removeService(existing);
      this.publishStructureChange();
      this.platform.log.debug(
        `Removed Dry switch for ${this.accessory.displayName} (device reports no dry mode support)`,
      );
    }
    this.dryService = null;
  }

  private isDryActive(status: DeviceStatus | null): boolean {
    if (!status) {
      return false;
    }
    return status.power === 1 && status.operationMode === 'dry';
  }

  async getDryOn(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.isDryActive(this.currentStatus);
  }

  async setDryOn(value: CharacteristicValue): Promise<void> {
    this.assertReachable();
    const on = value as boolean;
    const operationMode: 'dry' | 'off' = on ? 'dry' : 'off';
    const power: 0 | 1 = on ? 1 : 0;

    this.platform.log.info(
      `[DRY] ${this.accessory.displayName}: HomeKit sent ${on ? 'ON' : 'OFF'}`,
    );

    this.noteModeIntent(operationMode);

    const success = await this.sendDeviceCommand({ operationMode, power }, 'homekit:dry-switch');

    if (!success) {
      this.platform.log.error(
        `[DRY] ${this.accessory.displayName}: Failed to set dry ${on ? 'ON' : 'OFF'}`,
      );
      // Revert the switch to the actual device state
      setTimeout(() => {
        this.dryService?.updateCharacteristic(
          this.platform.Characteristic.On,
          this.isDryActive(this.currentStatus),
        );
      }, 100);
      return;
    }

    this.platform.log.info(`[DRY] ${this.accessory.displayName}: Command accepted by API`);

    // Optimistic local-state update so the climate tile reflects the change now.
    if (this.currentStatus) {
      this.currentStatus.operationMode = operationMode;
      this.currentStatus.power = on ? 1 : 0;
      this.rememberActiveMode(this.currentStatus);
      this.refreshClimateCharacteristics();
    }

    // Fan-only and dry are mutually exclusive — engaging dry means the unit is
    // no longer fan-only, so flip the fan switch off optimistically.
    if (this.fanOnlyService) {
      this.fanOnlyService.updateCharacteristic(this.platform.Characteristic.On, false);
    }

    // Mirror a HomeKit-driven dry toggle to any followers immediately.
    this.notifyStatusListeners();
  }

  private updateFilterMaintenance(filterDirty: boolean): void {
    if (!this.filterMaintenanceService) {
      this.filterMaintenanceService =
        this.accessory.getService(this.platform.Service.FilterMaintenance) ||
        this.accessory.addService(this.platform.Service.FilterMaintenance);
      this.linkSecondaryService(this.filterMaintenanceService);
      this.publishStructureChange();
      this.platform.log.debug(`Added FilterMaintenance service for ${this.accessory.displayName}`);
    }

    this.filterMaintenanceService.updateCharacteristic(
      this.platform.Characteristic.FilterChangeIndication,
      filterDirty
        ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
        : this.platform.Characteristic.FilterChangeIndication.FILTER_OK,
    );
  }

  /**
   * Indoor humidity as its own HumiditySensor service: HeaterCooler has no
   * CurrentRelativeHumidity characteristic. Created on the first reading from a
   * unit that has a sensor (or adopted from the cache in the constructor).
   */
  private setupHumidityService(): void {
    if (this.humidityService) {
      return;
    }
    const existing = this.accessory.getService(this.platform.Service.HumiditySensor);
    const name = `${this.accessory.context.device.displayName} Humidity`;
    this.humidityService =
      existing || this.accessory.addService(this.platform.Service.HumiditySensor, name);
    this.humidityService.setCharacteristic(this.platform.Characteristic.Name, name);
    this.humidityService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));
    this.linkSecondaryService(this.humidityService);
    if (!existing) {
      this.publishStructureChange();
    }
  }

  /**
   * Mark the HeaterCooler primary and link a secondary service to it, so the Home
   * app groups them on one tile. Guarded: a bare test stub has neither method, and a
   * throw here during construction would take out the whole accessory.
   */
  private linkSecondaryService(secondary: Service | null): void {
    if (!secondary) {
      return;
    }
    const primary = this.service as unknown as {
      setPrimaryService?: (v?: boolean) => void;
      addLinkedService?: (s: Service) => void;
    };
    if (typeof primary.setPrimaryService === 'function') {
      primary.setPrimaryService(true);
    }
    if (typeof primary.addLinkedService === 'function') {
      primary.addLinkedService(secondary);
    }
  }

  // Handle streaming updates
  private handleStreamingUpdate(deviceSerial: string, data: Partial<DeviceStatus>) {
    // Validate that we have essential data before processing
    if (data.roomTemp === undefined || data.roomTemp === null) {
      this.platform.log.debug(`Streaming update for ${deviceSerial} missing essential data, skipping`);
      return;
    }

    const updateTimestamp = Date.now();

    this.platform.log.debug(`Streaming update received for ${deviceSerial}: temp=${data.roomTemp}, mode=${data.operationMode}, power=${data.power}`);

    // Convert streaming data format to zone format for processing
    const zoneUpdate: Partial<Zone> = {
      adapter: {
        id: data.id || '',
        deviceSerial: deviceSerial,
        roomTemp: data.roomTemp!,
        spHeat: data.spHeat!,
        spCool: data.spCool!,
        spAuto: data.spAuto || null,
        humidity: data.humidity ?? null,
        power: data.power!,
        operationMode: data.operationMode!,
        // The cloud's own memory of the last mode; seeds power-on (seedActiveMode).
        previousOperationMode: (data as { previousOperationMode?: string }).previousOperationMode || data.operationMode!,
        // Unknown stays unknown: processZoneUpdate carries the last known value.
        fanSpeed: data.fanSpeed || undefined,
        airDirection: data.airDirection || undefined,
        connected: true,
        isSimulator: false,
        hasSensor: data.humidity !== null && data.humidity !== undefined,
        hasMhk2: false,
        scheduleOwner: 'adapter',
        scheduleHoldEndTime: 0,
        rssi: data.rssi,
      },
    } as Zone;

    // Use existing update processing logic
    this.processZoneUpdate(zoneUpdate as Zone, 'streaming', updateTimestamp);

    // Extract extended fields only available from streaming (not in Zone format)
    if (this.currentStatus) {
      this.currentStatus.modelNumber = (data as any).modelNumber;
      this.currentStatus.connected = (data as any).connected;
      const displayConfig = (data as any).displayConfig;
      if (displayConfig) {
        this.currentStatus.filterDirty = displayConfig.filter === true;
        this.currentStatus.defrost = displayConfig.defrost === true;
        this.currentStatus.standby = displayConfig.standby === true;
      }

      // Set model number once on AccessoryInformation
      if (!this.modelNumberSet && this.currentStatus.modelNumber) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
          .setCharacteristic(this.platform.Characteristic.Model, this.currentStatus.modelNumber);
        this.modelNumberSet = true;
        this.platform.log.info(`${this.accessory.displayName}: Model ${this.currentStatus.modelNumber}`);
      }

      // Update filter maintenance service
      this.updateFilterMaintenance(this.currentStatus.filterDirty ?? false);
      // standby arrives here, after processZoneUpdate published the tile, so
      // republish or IDLE shows one update late.
      if (this.isReachable()) {
        this.refreshClimateCharacteristics();
      }
    }
  }

  /**
   * Register a listener fired whenever this accessory's state changes. Used by the
   * MirrorController to follow a source unit. The listener receives the live
   * currentStatus; treat it as read-only.
   */
  public onStatusUpdate(listener: (status: DeviceStatus) => void): void {
    this.statusListeners.push(listener);
  }

  private notifyStatusListeners(): void {
    if (!this.currentStatus || this.statusListeners.length === 0) {
      return;
    }
    const snapshot = this.currentStatus;
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.platform.log.error('Status listener error:', err);
      }
    }
  }

  // Getter methods for platform to access private properties
  public getSiteId(): string {
    return this.siteId;
  }

  public getDeviceSerial(): string {
    return this.deviceSerial;
  }

  /**
   * When this accessory last APPLIED a real update (any source), for the platform's
   * resilience watchdog. 0 means nothing has been applied yet. Advances only past the
   * source/monotonicity guards, so a dropped (local-authoritative / stale) update does
   * not count as fresh data.
   */
  public getLastUpdateTs(): number {
    return this.lastUpdateTimestamp;
  }

  /**
   * Cloud reachability, driven by the `device_status_v2` streaming event.
   *
   * Why this exists (2026-09-10): the rear bedroom's Wi-Fi adapter dropped off the
   * network for ~22h. The Kumo cloud kept serving its LAST KNOWN state — `cool,
   * power=1` — from a frozen shadow record, so HomeKit cheerfully showed a tile
   * that was both wrong and unactionable: every `off` we sent returned HTTP 200
   * and reached nothing. The cloud told us the truth all along (we logged "reported
   * offline (reason: IoT Disconnected)") but nobody was listening — the callback
   * had no subscriber. Surfacing it as No Response is what HomeKit's unreachable
   * state is for, and it stops scenes silently "succeeding" against a dead unit.
   */
  public setCloudConnected(connected: boolean): void {
    const wasReachable = this.isReachable();
    this.cloudConnected = connected;
    const nowReachable = this.isReachable();

    if (wasReachable === nowReachable) {
      return;
    }

    if (nowReachable) {
      this.platform.log.info(`[REACHABILITY] ${this.accessory.displayName}: back online`);
      this.pushCurrentState();
    } else {
      this.platform.log.warn(
        `[REACHABILITY] ${this.accessory.displayName}: unreachable — the adapter is offline and ` +
        'there is no local LAN path. Showing No Response in HomeKit; its last reported state is stale.',
      );
      this.pushUnreachable();
    }
  }

  /**
   * Local LAN control bypasses the cloud entirely, so a unit we can still reach
   * over the LAN is reachable no matter what the cloud thinks.
   */
  private hasLocalControl(): boolean {
    const local = this.platform.localClient;
    return !!local && local.hasLocal(this.deviceSerial);
  }

  /**
   * Unreachable ONLY when the cloud has explicitly reported the adapter disconnected
   * and no local path exists. `null` (nothing reported yet) counts as reachable so a
   * fresh start never flashes No Response before the first status arrives.
   */
  public isReachable(): boolean {
    if (this.hasLocalControl()) {
      return true;
    }
    return this.cloudConnected !== false;
  }

  /**
   * HAP's "no response" signal. Built lazily and defensively — a bare Error still
   * reads as unreachable to HomeKit, which keeps this working under test harnesses
   * that stub `platform.api` without the full hap namespace.
   */
  private unreachableError(): Error {
    const hap = this.platform.api?.hap as
      | { HapStatusError?: new (s: number) => Error; HAPStatus?: { SERVICE_COMMUNICATION_FAILURE: number } }
      | undefined;
    if (hap?.HapStatusError && hap.HAPStatus) {
      return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return new Error('Device unreachable');
  }

  /**
   * Guard for every characteristic getter: throwing is what puts the accessory into
   * No Response, rather than handing HomeKit a stale cached value as if it were live.
   */
  private assertReachable(): void {
    if (!this.isReachable()) {
      throw this.unreachableError();
    }
  }

  /** Push the error to HomeKit immediately instead of waiting for the next read. */
  private pushUnreachable(): void {
    const err = this.unreachableError();
    const C = this.platform.Characteristic;
    for (const characteristic of [
      C.Active,
      C.CurrentHeaterCoolerState,
      C.TargetHeaterCoolerState,
      C.CurrentTemperature,
      C.HeatingThresholdTemperature,
      C.CoolingThresholdTemperature,
    ]) {
      this.service.updateCharacteristic(characteristic, err as never);
    }
    this.humidityService?.updateCharacteristic(C.CurrentRelativeHumidity, err as never);
    this.fanOnlyService?.updateCharacteristic(C.On, err as never);
    this.dryService?.updateCharacteristic(C.On, err as never);
  }

  /** Re-publish real values on recovery so the tile clears without waiting for a read. */
  private pushCurrentState(): void {
    if (!this.currentStatus) {
      return;
    }
    const C = this.platform.Characteristic;
    this.refreshClimateCharacteristics();
    if (typeof this.currentStatus.roomTemp === 'number' && !isNaN(this.currentStatus.roomTemp)) {
      this.service.updateCharacteristic(C.CurrentTemperature, this.currentStatus.roomTemp);
    }
    this.refreshThresholds(this.currentStatus);
    if (this.humidityService && typeof this.currentStatus.humidity === 'number') {
      this.humidityService.updateCharacteristic(C.CurrentRelativeHumidity, this.currentStatus.humidity);
    }
    this.fanOnlyService?.updateCharacteristic(C.On, this.isFanOnlyActive(this.currentStatus));
    this.dryService?.updateCharacteristic(C.On, this.isDryActive(this.currentStatus));
  }

  // Called by platform when new zone data is available
  public updateFromZone(zone: Zone) {
    const updateTimestamp = Date.now();
    this.processZoneUpdate(zone, 'polling', updateTimestamp);
  }

  /**
   * Called by the platform's local poller with a locally-read status. Humidity is
   * read separately (sensor/MHK2) by the poller and stamped onto `status.humidity`;
   * when a unit has no local humidity source it's absent and we keep whatever
   * streaming/cloud last reported rather than wiping it.
   */
  public updateFromLocal(status: Partial<DeviceStatus>) {
    if (status.roomTemp === undefined || status.roomTemp === null) {
      return;
    }
    const updateTimestamp = Date.now();
    const zoneUpdate: Partial<Zone> = {
      id: this.currentStatus?.id || '',
      adapter: {
        id: this.currentStatus?.id || '',
        deviceSerial: this.deviceSerial,
        roomTemp: status.roomTemp!,
        spHeat: status.spHeat!,
        spCool: status.spCool!,
        spAuto: status.spAuto ?? null,
        humidity: status.humidity ?? this.currentStatus?.humidity ?? null, // local sensor/MHK2 if present, else keep cloud's
        power: status.power!,
        operationMode: status.operationMode!,
        previousOperationMode: status.operationMode!,
        fanSpeed: status.fanSpeed || undefined,
        airDirection: status.airDirection || undefined,
        connected: true,
        isSimulator: false,
        hasSensor: (status.humidity ?? this.currentStatus?.humidity) != null,
        hasMhk2: false,
        scheduleOwner: 'adapter',
        scheduleHoldEndTime: 0,
      },
    } as Zone;

    this.processZoneUpdate(zoneUpdate as Zone, 'local', updateTimestamp);

    // Filter / defrost / standby come straight from the local status.
    if (this.currentStatus) {
      if (status.filterDirty !== undefined) {
        this.currentStatus.filterDirty = status.filterDirty;
      }
      if (status.defrost !== undefined) {
        this.currentStatus.defrost = status.defrost;
      }
      if (status.standby !== undefined) {
        this.currentStatus.standby = status.standby;
      }
      this.updateFilterMaintenance(this.currentStatus.filterDirty ?? false);
      // Same as the streaming path: standby lands after the tile was published.
      if (this.isReachable()) {
        this.refreshClimateCharacteristics();
      }
    }
  }

  /**
   * Send a control command, preferring the local LAN path when available and
   * falling back to the cloud. A failed local send (timeout/unreachable) also
   * falls back, so a flaky adapter never blocks control.
   */
  private async sendDeviceCommand(commands: Commands, origin: CommandOrigin): Promise<boolean> {
    // Record intent BEFORE the send: the resulting status update can race back
    // ahead of the await resolving, and an unattributed echo would be logged as
    // an external change.
    this.lastCommandOrigin = origin;
    this.lastCommandAt = Date.now();
    if (commands.operationMode !== undefined) {
      this.lastCommandLabel = commands.operationMode === 'off' ? 'off' : commands.operationMode;
    }

    const { ok, path } = await this.dispatchCommand(commands);
    this.platform.log.info(
      `[CMD] ${this.accessory.displayName} <- ${origin} via ${path}` +
      `${ok ? '' : ' FAILED'}: ${JSON.stringify(commands)}`,
    );
    return ok;
  }

  private async dispatchCommand(commands: Commands): Promise<{ ok: boolean; path: 'local' | 'cloud' }> {
    const local = this.platform.localClient;
    if (local && local.hasLocal(this.deviceSerial)) {
      const ok = await local.sendCommand(this.deviceSerial, commands);
      if (ok) {
        // A successful local command makes us authoritative for the unit's state:
        // we just set it. Mark it local-authoritative (same window a local poll
        // uses) so the Kumo cloud's ~7-10s lag can't replay the pre-command state
        // and clobber it. Without this, only a local *poll* refreshed the window —
        // so when polling was starved during a command burst, a stale cloud/streaming
        // update could be applied after an `off`, briefly flip the cached state back
        // on, and fire the mirror hook, reviving a mirror target (2026-07-23 skylight
        // regression). Local polls (every localPollInterval) confirm the real state
        // within the window.
        this.lastLocalUpdateTs = Date.now();
        return { ok: true, path: 'local' };
      }
      this.platform.log.debug(
        `[LOCAL] ${this.accessory.displayName}: local command failed — falling back to cloud`,
      );
    }
    return { ok: await this.kumoAPI.sendCommand(this.deviceSerial, commands), path: 'cloud' };
  }

  private processZoneUpdate(zone: Zone, source: 'streaming' | 'polling' | 'local', timestamp: number) {
    try {
      // When local control is healthy, it is the authoritative status source: drop
      // cloud (streaming/polling) updates that would clobber fresher local data,
      // since the cloud lags ~7-10s. Once local goes stale (unreachable), cloud
      // updates flow again.
      if (
        source !== 'local' &&
        this.lastLocalUpdateTs > 0 &&
        (Date.now() - this.lastLocalUpdateTs) < this.LOCAL_AUTHORITATIVE_MS
      ) {
        this.platform.log.debug(`[${this.deviceSerial}] Ignoring ${source} update — local is authoritative`);
        return;
      }

      // Prevent old updates from overwriting newer ones
      if (timestamp < this.lastUpdateTimestamp) {
        this.platform.log.debug(
          `[${this.deviceSerial}] Ignoring ${source} update: ` +
          `${this.lastUpdateTimestamp - timestamp}ms older than last ${this.lastUpdateSource} update`
        );
        return;
      }

      this.lastUpdateTimestamp = timestamp;
      const previousSource = this.lastUpdateSource;
      this.lastUpdateSource = source;
      if (source === 'local') {
        this.lastLocalUpdateTs = timestamp;
      }

      if (previousSource !== source && previousSource !== 'none') {
        this.platform.log.debug(`[${this.deviceSerial}] Update source changed: ${previousSource} → ${source}`);
      }

      this.platform.log.debug(`Processing ${source} update for ${this.deviceSerial}`);

      // Validate required fields
      if (zone.adapter.roomTemp === undefined || zone.adapter.roomTemp === null) {
        this.platform.log.error(`Device ${this.deviceSerial} has invalid roomTemp: ${zone.adapter.roomTemp}`);
        this.platform.log.debug('Zone adapter data:', JSON.stringify(zone.adapter));
        return;
      }

      // Check if device has humidity sensor and register characteristic if needed
      const hasHumidity = zone.adapter.humidity !== null && zone.adapter.humidity !== undefined;
      if (hasHumidity && !this.hasHumiditySensor && this.platform.kumoConfig?.showHumiditySensor !== false) {
        // Device has a humidity sensor: add the HumiditySensor service.
        this.hasHumiditySensor = true;
        this.setupHumidityService();
        this.platform.log.debug(`Added humidity sensor for device ${this.deviceSerial}`);
      }
      // Note: Once humidity is detected, we never remove the characteristic.
      // Streaming updates may intermittently omit humidity data, but that doesn't
      // mean the hardware sensor is gone. Toggling the characteristic destabilizes
      // HomeKit and causes "No Response" errors.

      // Convert adapter data to DeviceStatus format
      const status: DeviceStatus = {
        id: zone.id,
        deviceSerial: zone.adapter.deviceSerial,
        rssi: zone.adapter.rssi || 0,
        power: zone.adapter.power,
        operationMode: zone.adapter.operationMode,
        humidity: zone.adapter.humidity,
        // A cloud zone poll carries neither fan speed nor vane (it sends null). Keep
        // the last known value instead: the mirror's signature includes fan speed,
        // so a null here flipped it every time updates alternated between a poll and
        // streaming, which reads as a source change and fires a spurious push.
        fanSpeed: zone.adapter.fanSpeed ?? this.currentStatus?.fanSpeed ?? 'auto',
        airDirection: zone.adapter.airDirection ?? this.currentStatus?.airDirection ?? 'auto',
        roomTemp: zone.adapter.roomTemp,
        spCool: zone.adapter.spCool,
        spHeat: zone.adapter.spHeat,
        spAuto: zone.adapter.spAuto,
        // Not in any zone payload: streaming (displayConfig) and local reads set these
        // AFTER this rebuild, and a cloud poll never sets them. Replacing the status
        // object used to wipe them, so a poll cleared the filter flag and standby until
        // the next streaming update. Carry the last known values.
        // (Carry-forward ported from homebridge-mitsubishi-heatpump @ 83dfd18.)
        standby: this.currentStatus?.standby,
        defrost: this.currentStatus?.defrost,
        filterDirty: this.currentStatus?.filterDirty,
        modelNumber: this.currentStatus?.modelNumber,
        connected: this.currentStatus?.connected,
      };

      // Attribute observed power/mode transitions at INFO. Every command we SEND is
      // logged ([CMD]), but until this nothing recorded a change made OUTSIDE
      // Homebridge — the Kumo app, a schedule set there, or the unit itself. On
      // 2026-07-28 a Living room unit with no wall control went cool -> off with no
      // command on any logged path, and the log simply could not say what did it.
      //
      // Attribution requires a recent send AND a matching resulting label. A time
      // window alone would silently swallow an external change landing just after
      // one of our own commands — precisely the case worth catching.
      const prevLabel = powerModeLabel(this.currentStatus);
      const nextLabel = powerModeLabel(status);
      if (this.hasReceivedValidUpdate && prevLabel !== nextLabel) {
        const recentCommand =
          this.lastCommandOrigin !== null && (Date.now() - this.lastCommandAt) < this.ATTRIBUTION_MS;
        let cause: string;
        if (recentCommand && this.lastCommandLabel === nextLabel) {
          cause = `ours (${this.lastCommandOrigin})`;
        } else if (recentCommand) {
          // A recent command exists but the unit reports something else. Most often
          // this is the cloud replaying pre-command state (~7-10s lag, see the
          // local-authoritative window) rather than a person. Do NOT call it
          // EXTERNAL — crying wolf here would make the signal useless.
          cause =
            `UNEXPECTED — we just sent ${this.lastCommandOrigin} (${this.lastCommandLabel}); ` +
            'likely a stale cloud replay';
        } else {
          // The adapter reports state, never provenance — a wall control, the
          // Kumo app, a Kumo-side schedule and the unit's own firmware all look
          // identical from here. The only attributable distinction is ours vs
          // not-ours.
          cause = 'EXTERNAL — wall control, Kumo app, a schedule there, or the unit itself';
        }
        this.platform.log.info(
          `[STATE] ${this.accessory.displayName}: ${prevLabel} -> ${nextLabel} (seen via ${source}) — ${cause}`,
        );
      }

      this.currentStatus = status;
      this.hasReceivedValidUpdate = true; // Mark that we've received at least one valid complete update
      this.platform.log.debug(`${this.accessory.displayName}: ${status.roomTemp}°C (heat ${status.spHeat}°C / cool ${status.spCool}°C, mode: ${status.operationMode})`);

      // A unit whose adapter is offline has no live state to publish — anything
      // arriving now is the cloud replaying its frozen shadow record. Keep the
      // cached status (recovery republishes it) but leave HomeKit in No Response,
      // and don't mirror a stale reading onto a live target.
      if (!this.isReachable()) {
        this.platform.log.debug(
          `[${this.deviceSerial}] Unreachable — cached ${source} update without publishing to HomeKit`,
        );
        return;
      }

      // A live, active reading is what power-on restores (see rememberActiveMode).
      // After the reachability check: a frozen shadow replay must not overwrite it.
      this.rememberActiveMode(status);
      this.seedActiveMode(zone.adapter.previousOperationMode);

      // Update all characteristics
      this.refreshClimateCharacteristics();

      // Only update temperature if valid
      if (status.roomTemp !== undefined && status.roomTemp !== null && !isNaN(status.roomTemp)) {
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentTemperature,
          status.roomTemp,
        );
      }

      // Both thresholds, every update: on HeaterCooler they're the setpoints in every
      // mode (heat shows spHeat, cool shows spCool, auto shows the band).
      this.refreshThresholds(status);

      // Only update humidity if the device has a humidity sensor
      if (this.hasHumiditySensor && status.humidity !== null && status.humidity !== undefined) {
        this.humidityService?.updateCharacteristic(
          this.platform.Characteristic.CurrentRelativeHumidity,
          status.humidity,
        );
      }

      // Keep the fan-only switch in sync with the underlying device mode
      if (this.fanOnlyService) {
        this.fanOnlyService.updateCharacteristic(
          this.platform.Characteristic.On,
          this.isFanOnlyActive(status),
        );
      }

      // Keep the dry switch in sync with the underlying device mode
      if (this.dryService) {
        this.dryService.updateCharacteristic(
          this.platform.Characteristic.On,
          this.isDryActive(status),
        );
      }

      // Notify mirror listeners — this only runs on an applied update (early
      // returns above skip it), so a dropped/stale update never mirrors.
      this.notifyStatusListeners();
    } catch (error) {
      this.platform.log.error('Error updating device status:', error);
    }
  }

  /** On/off. HeaterCooler splits this out from the mode, unlike Thermostat. */
  private mapToActive(status: DeviceStatus): number {
    const C = this.platform.Characteristic;
    return status.power === 1 && status.operationMode !== 'off' ? C.Active.ACTIVE : C.Active.INACTIVE;
  }

  /**
   * What the unit is doing right now. HeaterCooler has a real IDLE, so a compressor
   * in standby and fan-only can be reported honestly instead of dressed up as COOL.
   * That retires the 1.7.1 dry/vent -> COOL workaround: it existed only because the
   * Thermostat's OFF meant both "not running" and "powered down", so iOS suppressed
   * an off-scene write as redundant. Here power is `Active`, a separate
   * characteristic, so a scene turning the unit off is always a real 1 -> 0.
   */
  private mapToCurrentHeaterCoolerState(status: DeviceStatus): number {
    const C = this.platform.Characteristic.CurrentHeaterCoolerState;
    if (status.power === 0 || status.operationMode === 'off') {
      return C.INACTIVE;
    }
    if (status.standby === true) {
      return C.IDLE; // on and holding its setpoint, compressor resting
    }
    switch (status.operationMode) {
      case 'heat':
      case 'autoHeat':
        return C.HEATING;
      case 'cool':
      case 'autoCool':
      case 'dry': // dehumidify runs the compressor with the coil cold
        return C.COOLING;
      case 'vent':
        return C.IDLE; // fan only: on, moving air, neither heating nor cooling
      case 'auto': {
        // Plain 'auto' without the unit saying which way it went: infer from the band.
        const heat = this.validSetpoint(status.spHeat) ?? 20;
        const cool = this.validSetpoint(status.spCool) ?? 24;
        if (status.roomTemp > cool) {
          return C.COOLING;
        }
        if (status.roomTemp < heat) {
          return C.HEATING;
        }
        return C.IDLE;
      }
      default:
        return C.INACTIVE;
    }
  }

  /**
   * The requested mode. TargetHeaterCoolerState has only AUTO/HEAT/COOL: no OFF
   * (that's `Active`) and nothing for dry or fan-only, which report COOL (dry's
   * setpoint lives in spCool). While the unit is off it shows the mode power-on
   * will restore, not a guess.
   */
  private mapToTargetHeaterCoolerState(status: DeviceStatus | null): number {
    const off = !status || status.power === 0 || status.operationMode === 'off';
    return this.modeToTargetState(off ? this.lastActiveMode() : status!.operationMode);
  }

  private modeToTargetState(mode: string): number {
    const T = this.platform.Characteristic.TargetHeaterCoolerState;
    if (this.isAutoMode(mode)) {
      return T.AUTO;
    }
    if (mode === 'heat') {
      return T.HEAT;
    }
    return T.COOL; // cool, dry, vent
  }

  /** Push Active and both heater-cooler states from the cached status. */
  private refreshClimateCharacteristics(): void {
    if (!this.currentStatus) {
      return;
    }
    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.Active, this.mapToActive(this.currentStatus));
    this.service.updateCharacteristic(
      C.CurrentHeaterCoolerState, this.mapToCurrentHeaterCoolerState(this.currentStatus));
    this.service.updateCharacteristic(
      C.TargetHeaterCoolerState, this.mapToTargetHeaterCoolerState(this.currentStatus));
  }

  /** Push both setpoints (thresholds) from a status, skipping missing values. */
  private refreshThresholds(status: DeviceStatus): void {
    const C = this.platform.Characteristic;
    const heat = this.validSetpoint(status.spHeat);
    const cool = this.validSetpoint(status.spCool);
    if (heat !== undefined) {
      this.service.updateCharacteristic(C.HeatingThresholdTemperature, heat);
    }
    if (cool !== undefined) {
      this.service.updateCharacteristic(C.CoolingThresholdTemperature, cool);
    }
  }

  private validSetpoint(v: number | null | undefined): number | undefined {
    return typeof v === 'number' && !isNaN(v) ? v : undefined;
  }

  /** Collapse a reported mode (autoHeat/autoCool) to one the API accepts; null if not an active mode. */
  private normalizeSendMode(mode: string | undefined | null): ActiveMode | null {
    if (!mode) {
      return null;
    }
    if (this.isAutoMode(mode)) {
      return 'auto';
    }
    if (mode === 'heat' || mode === 'cool' || mode === 'dry' || mode === 'vent') {
      return mode;
    }
    return null;
  }

  /**
   * Remember the mode power-on should restore. HomeKit sends Active=1 with no mode
   * of its own, and an off unit reports mode 'off'; the fork this code came from
   * fell back to AUTO there, so every unit turned on in AUTO. Kept in accessory
   * context, which Homebridge persists, so it survives a restart while the unit is off.
   */
  private rememberActiveMode(status: DeviceStatus): void {
    if (status.power !== 1) {
      return;
    }
    const mode = this.normalizeSendMode(status.operationMode);
    if (mode && this.accessory.context) {
      this.accessory.context.lastActiveMode = mode;
    }
  }

  /** Seed the remembered mode from the cloud's own memory, only if we have none. */
  private seedActiveMode(previousOperationMode: string | undefined | null): void {
    if (!this.accessory.context || this.accessory.context.lastActiveMode) {
      return;
    }
    const mode = this.normalizeSendMode(previousOperationMode);
    if (mode) {
      this.accessory.context.lastActiveMode = mode;
    }
  }

  private lastActiveMode(): ActiveMode {
    return this.normalizeSendMode(this.accessory.context?.lastActiveMode) ?? this.defaultOnMode();
  }

  /** Power-on mode with nothing remembered: AUTO where it exists, else COOL. */
  private defaultOnMode(): 'cool' | 'auto' {
    return this.deviceProfile && !this.deviceProfile.hasModeHeat ? 'cool' : 'auto';
  }

  private isAutoMode(operationMode: string): boolean {
    return operationMode.startsWith('auto');
  }

  /**
   * Whether dry mode exposes a settable temperature target on this unit.
   *
   * On the Kumo v3 cloud the dry setpoint lives in `spCool` (there is no spDry
   * field), and the device profile reports `usesSetPointInDryMode`. We treat dry
   * as having a setpoint unless the profile is loaded and explicitly says it
   * doesn't — so the common case still works during the brief window before the
   * async profile_update arrives. Verified live: writing `spCool` while in dry is
   * adopted and the unit stays in dry.
   */
  private dryUsesSetpoint(): boolean {
    return this.deviceProfile === null || this.deviceProfile.usesSetPointInDryMode;
  }

  /**
   * Record HomeKit's mode intent so a concurrent scene setpoint can't revive a
   * unit that's being turned off. Called synchronously (before the command's
   * await) from every mode-changing setter: open the suppression window on
   * `off`, clear it on any active mode.
   */
  private noteModeIntent(operationMode: string): void {
    this.offRequestedAt = operationMode === 'off' ? Date.now() : 0;
  }

  /**
   * Whether a setpoint write should be suppressed (cached + echoed, not sent).
   * True when the unit is already off, or when a HomeKit off was requested within
   * OFF_SUPPRESS_WINDOW_MS — the window covers the concurrent "AC off" scene
   * burst, where the off command's optimistic state update hasn't landed yet.
   */
  /**
   * Hold a setpoint write for SETPOINT_HOLD_MS before sending it, so a
   * concurrent "AC off" can cancel it whichever order HomeKit dispatched them in.
   *
   *  - 'send'       — go ahead
   *  - 'superseded' — a newer write to the same setpoint arrived; drop this one
   *                   silently (don't cache a stale value over the newer one)
   *  - 'suppressed' — the unit is off / turning off; cache + echo, don't send
   */
  private async holdSetpointWrite(key: string): Promise<'send' | 'superseded' | 'suppressed'> {
    const gen = (this.setpointWriteGen.get(key) || 0) + 1;
    this.setpointWriteGen.set(key, gen);
    await new Promise(resolve => setTimeout(resolve, this.SETPOINT_HOLD_MS));
    if (this.setpointWriteGen.get(key) !== gen) {
      return 'superseded';
    }
    return this.shouldSuppressSetpoint() ? 'suppressed' : 'send';
  }

  private shouldSuppressSetpoint(): boolean {
    if (!this.currentStatus) {
      return false;
    }
    return (
      this.currentStatus.power === 0 ||
      this.currentStatus.operationMode === 'off' ||
      Date.now() - this.offRequestedAt < this.OFF_SUPPRESS_WINDOW_MS
    );
  }

  /**
   * True only while a HomeKit "off" is in flight, i.e. inside the scene burst.
   * Distinct from shouldSuppressSetpoint(), which is also true for a unit that has
   * simply been off a while: picking a mode on an off unit is how a user turns it
   * on, and must keep working.
   */
  private offInFlight(): boolean {
    return Date.now() - this.offRequestedAt < this.OFF_SUPPRESS_WINDOW_MS;
  }

  // ---- HeaterCooler: power and mode ---------------------------------------

  async getActive(): Promise<CharacteristicValue> {
    this.assertReachable();
    if (!this.currentStatus) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return this.mapToActive(this.currentStatus);
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    this.assertReachable();
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    this.platform.log.info(`[ACTIVE] ${this.accessory.displayName}: HomeKit sent ${on ? 'ON' : 'OFF'}`);
    if (!on) {
      // Synchronously, before anything awaits: a setpoint write dispatched in the
      // same scene burst must see the off (see offRequestedAt).
      this.noteModeIntent('off');
    }
    return this.queuePowerMode({ active: on });
  }

  async getCurrentHeaterCoolerState(): Promise<CharacteristicValue> {
    this.assertReachable();
    if (!this.currentStatus) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    return this.mapToCurrentHeaterCoolerState(this.currentStatus);
  }

  async getTargetHeaterCoolerState(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.mapToTargetHeaterCoolerState(this.currentStatus);
  }

  async setTargetHeaterCoolerState(value: CharacteristicValue): Promise<void> {
    this.assertReachable();
    const T = this.platform.Characteristic.TargetHeaterCoolerState;
    let mode: 'heat' | 'cool' | 'auto';
    switch (value) {
      case T.HEAT: mode = 'heat'; break;
      case T.COOL: mode = 'cool'; break;
      case T.AUTO: mode = 'auto'; break;
      default:
        this.platform.log.error('Unknown target heater-cooler state:', value);
        return;
    }
    this.platform.log.info(`[MODE CHANGE] ${this.accessory.displayName}: HomeKit sent ${mode.toUpperCase()}`);
    return this.queuePowerMode({ mode });
  }

  /**
   * Collect power and mode writes from one HomeKit request into one command.
   * hap-nodejs dispatches every handler in a write request concurrently, so they
   * all land here before the zero-delay timer fires. Every caller in the burst
   * gets the same promise, resolved once the command has been sent.
   */
  private queuePowerMode(patch: { active?: boolean; mode?: 'heat' | 'cool' | 'auto' }): Promise<void> {
    this.pendingPowerMode = { ...(this.pendingPowerMode ?? {}), ...patch };
    if (!this.powerModeFlush) {
      this.powerModeFlush = new Promise<void>((resolve) => {
        setTimeout(() => {
          const intent = this.pendingPowerMode ?? {};
          this.pendingPowerMode = null;
          this.powerModeFlush = null;
          this.flushPowerMode(intent)
            .catch((err) => this.platform.log.error(`${this.accessory.displayName}: power/mode error:`, err))
            .then(resolve, resolve);
        }, 0);
      });
    }
    return this.powerModeFlush;
  }

  /**
   * Resolve one burst of power/mode intent into a single command:
   *  - Active=0 wins: off, whatever mode came with it (an "AC off" scene re-sends
   *    its captured mode alongside the off).
   *  - Active=1 with a mode: on in that mode. Without one: the last active mode.
   *  - A mode alone: on in that mode, unless it trails an off in the same scene
   *    burst, which would revive the unit the off just stopped.
   * Turning on also carries any setpoint written while off in this same burst, so
   * "on, cool, 72" lands as one command at 72 instead of at the old setpoint.
   */
  private async flushPowerMode(intent: { active?: boolean; mode?: 'heat' | 'cool' | 'auto' }): Promise<void> {
    const name = this.accessory.displayName;
    let operationMode: 'off' | ActiveMode;
    if (intent.active === false) {
      operationMode = 'off';
    } else if (intent.active === true) {
      operationMode = intent.mode ?? this.lastActiveMode();
    } else if (intent.mode) {
      if (this.offInFlight()) {
        this.platform.log.debug(`[MODE CHANGE] ${name}: an off is in flight — not sending ${intent.mode}`);
        setTimeout(() => this.refreshClimateCharacteristics(), 100);
        return;
      }
      operationMode = intent.mode;
    } else {
      return;
    }

    // An active mode clears any pending off window (the off itself was noted
    // synchronously in setActive).
    if (operationMode !== 'off') {
      this.noteModeIntent(operationMode);
    }

    const commands: Commands = { operationMode };
    const wasOff = !this.currentStatus || this.currentStatus.power === 0 || this.currentStatus.operationMode === 'off';
    if (operationMode !== 'off' && wasOff) {
      this.attachSameBurstSetpoints(commands, operationMode);
    }
    this.setpointsCachedWhileOff.clear();

    const origin: CommandOrigin = intent.active !== undefined ? 'homekit:active' : 'homekit:mode';
    const label = origin === 'homekit:active' ? 'ACTIVE' : 'MODE CHANGE';
    const success = await this.sendDeviceCommand(commands, origin);
    if (!success) {
      this.platform.log.error(`[${label}] ${name}: failed to set ${operationMode}`);
      setTimeout(() => this.refreshClimateCharacteristics(), 100);
      return;
    }

    if (this.currentStatus) {
      this.currentStatus.operationMode = operationMode;
      this.currentStatus.power = operationMode === 'off' ? 0 : 1;
      if (commands.spHeat !== undefined) {
        this.currentStatus.spHeat = commands.spHeat;
      }
      if (commands.spCool !== undefined) {
        this.currentStatus.spCool = commands.spCool;
      }
      this.rememberActiveMode(this.currentStatus);
      this.refreshClimateCharacteristics();
      this.refreshThresholds(this.currentStatus);
    }
    // Heat/cool/auto/off leave the Dry and Fan switches off; a power-on that
    // restored dry or fan-only turns its switch on.
    this.fanOnlyService?.updateCharacteristic(this.platform.Characteristic.On, this.isFanOnlyActive(this.currentStatus));
    this.dryService?.updateCharacteristic(this.platform.Characteristic.On, this.isDryActive(this.currentStatus));
    this.notifyStatusListeners();
  }

  /** Add setpoints written while the unit was off, if they arrived in this burst. */
  private attachSameBurstSetpoints(commands: Commands, mode: ActiveMode): void {
    const now = Date.now();
    const fresh = (field: SetpointField): number | undefined => {
      const cached = this.setpointsCachedWhileOff.get(field);
      return cached && now - cached.at <= this.SAME_BURST_MS ? cached.value : undefined;
    };
    if (mode === 'heat' || mode === 'auto') {
      const v = fresh('spHeat');
      if (v !== undefined) {
        commands.spHeat = v;
      }
    }
    if (mode === 'cool' || mode === 'auto' || (mode === 'dry' && this.dryUsesSetpoint())) {
      const v = fresh('spCool');
      if (v !== undefined) {
        commands.spCool = v;
      }
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    this.assertReachable();
    // Never block on API calls - return cached or default value immediately
    if (!this.currentStatus) {
      this.platform.log.debug('No status available yet for getCurrentTemperature, returning default');
      return 20; // Default fallback temperature
    }

    const temp = this.currentStatus.roomTemp;
    if (temp === undefined || temp === null || isNaN(temp)) {
      // Only warn if we've received valid updates before (not during initial state)
      if (this.hasReceivedValidUpdate) {
        this.platform.log.warn(`Invalid roomTemp value for ${this.accessory.displayName}:`, temp);
      }
      return 20; // Default fallback temperature
    }

    this.platform.log.debug(`HomeKit get current temp for ${this.accessory.displayName}: ${temp}°C`);
    return temp;
  }

  // ---- Setpoints -----------------------------------------------------------
  // The two thresholds are the setpoint controls in every mode: the heating
  // threshold (spHeat) in HEAT, the cooling threshold (spCool) in COOL and in dry,
  // and both as a range in AUTO (these units have no spAuto).

  async getHeatingThresholdTemperature(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.getThresholdTemperature('spHeat', 20);
  }

  async getCoolingThresholdTemperature(): Promise<CharacteristicValue> {
    this.assertReachable();
    return this.getThresholdTemperature('spCool', 24);
  }

  private getThresholdTemperature(field: 'spHeat' | 'spCool', fallback: number): number {
    if (!this.currentStatus) {
      return fallback;
    }
    const v = this.currentStatus[field];
    if (v === undefined || v === null || isNaN(v)) {
      return fallback;
    }
    return v;
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue) {
    this.assertReachable();
    await this.setThresholdTemperature('spHeat', this.quantize('spHeat', value as number));
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue) {
    this.assertReachable();
    await this.setThresholdTemperature('spCool', this.quantize('spCool', value as number));
  }

  /**
   * Snap an inbound setpoint to the whole-°F grid, inside this unit's range, so
   * "72°F" is stored as 22.3°C and both the Home app and the Comfort app show 72.
   * It has to happen here: HAP applies minStep only outbound and hands a
   * controller's write through verbatim, and 1.x rounded on the LAN path only, so
   * the same tap stored a different value depending on which transport carried it.
   */
  private quantize(field: SetpointField, temp: number): number {
    const r = this.setpointRanges(this.deviceProfile);
    const [min, max] = field === 'spHeat' ? [r.heatMin, r.heatMax] : [r.coolMin, r.coolMax];
    const q = quantizeSetpointInRange(temp, min, max);
    if (q !== temp) {
      this.platform.log.debug(
        `[SETPOINT] ${this.accessory.displayName}: ${temp}°C -> ${q}°C (${cToF(q).toFixed(0)}°F on the whole-°F grid)`,
      );
    }
    return q;
  }

  /**
   * Write one setpoint. Powered-off guard (the v3 API 400s a bare setpoint on an
   * off unit, see 1.5.2), a brief hold so a concurrent "AC off" wins (1.8.2),
   * optimistic echo, and revert on failure.
   */
  private async setThresholdTemperature(field: SetpointField, temp: number): Promise<void> {
    const characteristic = field === 'spHeat'
      ? this.platform.Characteristic.HeatingThresholdTemperature
      : this.platform.Characteristic.CoolingThresholdTemperature;
    const label = field === 'spHeat' ? 'HEAT SP' : 'COOL SP';
    const fallback = field === 'spHeat' ? 20 : 24;

    const tempF = (temp * 9 / 5) + 32;
    this.platform.log.info(
      `[${label}] ${this.accessory.displayName}: HomeKit sent ${temp.toFixed(1)}°C (${tempF.toFixed(1)}°F)`,
    );

    if (!this.currentStatus) {
      this.platform.log.error(`[${label}] ${this.accessory.displayName}: no current status`);
      return;
    }

    // Don't send a setpoint to a powered-off (or being-turned-off) unit: cache +
    // echo only so the handle holds, without a doomed `modeRequiredWhenDeviceOff`
    // 400 (1.5.2) and without a trailing setpoint reviving a unit an "AC off"
    // scene is turning off (see offRequestedAt / shouldSuppressSetpoint).
    if (this.shouldSuppressSetpoint()) {
      this.platform.log.debug(
        `[${label}] ${this.accessory.displayName}: unit is off / turning off — caching ${temp}°C without sending`,
      );
      this.currentStatus[field] = temp;
      this.service.updateCharacteristic(characteristic, temp);
      // Off but not being turned off: a power-on in this same burst carries it
      // (see attachSameBurstSetpoints). Setpoints trailing an off are never kept.
      if (!this.offInFlight()) {
        this.setpointsCachedWhileOff.set(field, { value: temp, at: Date.now() });
      }
      return;
    }

    const commands: { spHeat?: number; spCool?: number } = {};
    commands[field] = temp;

    // Hold briefly so an "AC off" dispatched alongside this handle wins
    // regardless of order (see setpointWriteGen). Keyed per field so the two
    // AUTO handles don't supersede each other.
    const hold = await this.holdSetpointWrite(field);
    if (hold === 'superseded') {
      return;
    }
    if (hold === 'suppressed') {
      this.platform.log.debug(
        `[${label}] ${this.accessory.displayName}: unit turned off while held — caching ${temp}°C without sending`,
      );
      if (this.currentStatus) {
        this.currentStatus[field] = temp;
      }
      this.service.updateCharacteristic(characteristic, temp);
      return;
    }

    const success = await this.sendDeviceCommand(commands, 'homekit:threshold');

    if (success) {
      this.platform.log.info(`[${label}] ${this.accessory.displayName}: Command accepted by API`);
      this.currentStatus[field] = temp;
      this.service.updateCharacteristic(characteristic, temp);
      // Mirror a HomeKit-driven AUTO-handle change to any followers immediately.
      this.notifyStatusListeners();
    } else {
      this.platform.log.error(`[${label}] ${this.accessory.displayName}: Failed to set ${field} to ${temp}`);
      // Revert the handle to the actual device state
      setTimeout(() => {
        this.service.updateCharacteristic(characteristic, this.getThresholdTemperature(field, fallback));
      }, 100);
    }
  }


  // ---- Device mirroring (target side) -------------------------------------
  // Driven by the MirrorController when a source unit changes. Reconstructs a
  // single atomic command from the source's desired state, clamped to this unit's
  // own limits — one combined command, so the 1.7.2 trailing-setpoint race cannot
  // recur. See docs/superpowers/specs/2026-07-22-device-mirroring-design.md.

  /** Clamp a setpoint to this unit's supported range for a mode (no-op until profile loads). */
  private clampSetpoint(value: number, mode: 'heat' | 'cool' | 'auto'): number {
    if (typeof value !== 'number' || isNaN(value) || !this.deviceProfile) {
      return value;
    }
    const min = this.deviceProfile.minimumSetPoints[mode];
    const max = this.deviceProfile.maximumSetPoints[mode];
    if (typeof min === 'number' && value < min) {
      return min;
    }
    if (typeof max === 'number' && value > max) {
      return max;
    }
    return value;
  }

  /** Collapse a raw source mode to a command mode (autoHeat/autoCool → auto, off if powered off). */
  private normalizeMirrorMode(desired: MirrorState): 'off' | 'heat' | 'cool' | 'auto' | 'dry' | 'vent' {
    if (desired.power === 0 || desired.operationMode === 'off') {
      return 'off';
    }
    const m = desired.operationMode;
    if (m.startsWith('auto')) {
      return 'auto';
    }
    if (m === 'heat' || m === 'cool' || m === 'dry' || m === 'vent') {
      return m;
    }
    return 'off';
  }

  /**
   * Apply a source unit's state to this (target) unit. One combined command
   * (mode + mode-appropriate setpoint(s) + fan), clamped to this unit's range and
   * guarded against modes it can't do. Sends via the normal local-first path.
   */
  public async applyMirror(desired: MirrorState): Promise<void> {
    const mode = this.normalizeMirrorMode(desired);

    if (mode === 'dry' && this.deviceProfile && !this.deviceProfile.hasModeDry) {
      this.platform.log.warn(`[MIRROR] ${this.accessory.displayName}: target has no dry mode — skipping`);
      return;
    }
    if (mode === 'vent' && this.deviceProfile && !this.deviceProfile.hasModeVent) {
      this.platform.log.warn(`[MIRROR] ${this.accessory.displayName}: target has no vent mode — skipping`);
      return;
    }

    const commands: Commands = {};
    const fan = desired.fanSpeed;
    switch (mode) {
      case 'off':
        commands.operationMode = 'off';
        break;
      case 'heat':
        commands.operationMode = 'heat';
        commands.spHeat = this.clampSetpoint(desired.spHeat, 'heat');
        if (fan) {
          commands.fanSpeedRaw = fan;
        }
        break;
      case 'cool':
        commands.operationMode = 'cool';
        commands.spCool = this.clampSetpoint(desired.spCool, 'cool');
        if (fan) {
          commands.fanSpeedRaw = fan;
        }
        break;
      case 'auto':
        commands.operationMode = 'auto';
        commands.spHeat = this.clampSetpoint(desired.spHeat, 'auto');
        commands.spCool = this.clampSetpoint(desired.spCool, 'auto');
        if (fan) {
          commands.fanSpeedRaw = fan;
        }
        break;
      case 'dry':
        commands.operationMode = 'dry';
        commands.power = 1;
        if (this.dryUsesSetpoint()) {
          commands.spCool = this.clampSetpoint(desired.spCool, 'cool');
        }
        if (fan) {
          commands.fanSpeedRaw = fan;
        }
        break;
      case 'vent':
        commands.operationMode = 'vent';
        commands.power = 1;
        if (fan) {
          commands.fanSpeedRaw = fan;
        }
        break;
    }

    this.platform.log.info(`[MIRROR] ${this.accessory.displayName}: applying ${JSON.stringify(commands)}`);
    this.noteModeIntent(commands.operationMode!);

    const success = await this.sendDeviceCommand(commands, 'mirror');
    if (!success) {
      this.platform.log.error(`[MIRROR] ${this.accessory.displayName}: mirror command failed`);
      return;
    }

    // Optimistic echo so the tile reflects the mirror immediately; the next poll
    // reconciles authoritatively.
    if (this.currentStatus) {
      this.currentStatus.operationMode = commands.operationMode!;
      this.currentStatus.power = commands.operationMode === 'off' ? 0 : 1;
      if (commands.spHeat !== undefined) {
        this.currentStatus.spHeat = commands.spHeat;
      }
      if (commands.spCool !== undefined) {
        this.currentStatus.spCool = commands.spCool;
      }
      if (fan) {
        this.currentStatus.fanSpeed = fan;
      }

      this.rememberActiveMode(this.currentStatus);
      this.refreshClimateCharacteristics();
      this.refreshThresholds(this.currentStatus);
      if (this.dryService) {
        this.dryService.updateCharacteristic(
          this.platform.Characteristic.On,
          this.isDryActive(this.currentStatus),
        );
      }
      if (this.fanOnlyService) {
        this.fanOnlyService.updateCharacteristic(
          this.platform.Characteristic.On,
          this.isFanOnlyActive(this.currentStatus),
        );
      }
    }
  }

  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    this.assertReachable();
    // Cached only, like every other getter. This used to fetch
    // GET /devices/{serial}/status when nothing was cached yet and store the result
    // AS the unit's status — but that endpoint returns firmware/Wi-Fi fields, not
    // mode or temperatures, so every other getter then read a record with no
    // operationMode or roomTemp until the next real update replaced it.
    const humidity = this.currentStatus?.humidity || 0;
    this.platform.log.debug('Get CurrentRelativeHumidity:', humidity);
    return humidity;
  }

  destroy() {
    // Unsubscribe from streaming updates
    this.kumoAPI.unsubscribeFromDevice(this.deviceSerial);
    this.platform.log.debug(`Unsubscribed from streaming updates for ${this.deviceSerial}`);

    // Note: No per-device polling timer to clean up
    // Polling is handled at the platform level
  }
}
