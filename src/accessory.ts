import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { KumoV3Platform } from './platform';
import { KumoAPI } from './kumo-api';
import { POLL_INTERVAL, DeviceStatus, Zone } from './settings';

export class KumoThermostatAccessory {
  private service: Service;
  private pollTimer: NodeJS.Timeout | null = null;

  private deviceSerial: string;
  private siteId: string;
  private currentStatus: DeviceStatus | null = null;
  private pollIntervalMs: number;
  private hasHumiditySensor: boolean = false;

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

    this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.displayName,
    );

    // Register handlers for required characteristics
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // Note: Polling is now handled at the platform level (centralized site polling)
    // This accessory will receive updates via updateFromZone()

    // Register for streaming updates
    this.kumoAPI.subscribeToDevice(this.deviceSerial, this.handleStreamingUpdate.bind(this));
    this.platform.log.debug(`Registered streaming callback for ${this.deviceSerial}`);
  }

  // Handle streaming updates
  private handleStreamingUpdate(deviceSerial: string, data: Partial<DeviceStatus>) {
    // Validate that we have essential data before processing
    if (data.roomTemp === undefined || data.roomTemp === null) {
      this.platform.log.debug(`Streaming update for ${deviceSerial} missing essential data, skipping`);
      return;
    }

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
        humidity: data.humidity || null,
        power: data.power!,
        operationMode: data.operationMode!,
        previousOperationMode: data.operationMode!,
        fanSpeed: data.fanSpeed || 'auto',
        airDirection: data.airDirection || 'auto',
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
    this.processZoneUpdate(zoneUpdate as Zone);
  }

  // Getter methods for platform to access private properties
  public getSiteId(): string {
    return this.siteId;
  }

  public getDeviceSerial(): string {
    return this.deviceSerial;
  }

  // Called by platform when new zone data is available
  public updateFromZone(zone: Zone) {
    this.processZoneUpdate(zone);
  }
  private processZoneUpdate(zone: Zone) {
    try {
      this.platform.log.debug(`Processing zone update for ${this.deviceSerial}`);

      // Validate required fields
      if (zone.adapter.roomTemp === undefined || zone.adapter.roomTemp === null) {
        this.platform.log.error(`Device ${this.deviceSerial} has invalid roomTemp: ${zone.adapter.roomTemp}`);
        this.platform.log.debug('Zone adapter data:', JSON.stringify(zone.adapter));
        return;
      }

      // Check if device has humidity sensor and register characteristic if needed
      const hasHumidity = zone.adapter.humidity !== null && zone.adapter.humidity !== undefined;
      if (hasHumidity && !this.hasHumiditySensor) {
        // Device has humidity sensor - add the characteristic
        this.hasHumiditySensor = true;
        this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
          .onGet(this.getCurrentRelativeHumidity.bind(this));
        this.platform.log.debug(`Added humidity characteristic for device ${this.deviceSerial}`);
      } else if (!hasHumidity && this.hasHumiditySensor) {
        // Device no longer has humidity sensor - remove the characteristic
        this.hasHumiditySensor = false;
        if (this.service.testCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)) {
          this.service.removeCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity),
          );
          this.platform.log.debug(`Removed humidity characteristic for device ${this.deviceSerial}`);
        }
      }

      // Convert adapter data to DeviceStatus format
      const status: DeviceStatus = {
        id: zone.id,
        deviceSerial: zone.adapter.deviceSerial,
        rssi: zone.adapter.rssi || 0,
        power: zone.adapter.power,
        operationMode: zone.adapter.operationMode,
        humidity: zone.adapter.humidity,
        fanSpeed: zone.adapter.fanSpeed,
        airDirection: zone.adapter.airDirection,
        roomTemp: zone.adapter.roomTemp,
        spCool: zone.adapter.spCool,
        spHeat: zone.adapter.spHeat,
        spAuto: zone.adapter.spAuto,
      };

      this.currentStatus = status;
      this.platform.log.debug(`${this.accessory.displayName}: ${status.roomTemp}°C (target: ${this.getTargetTempFromStatus(status)}°C, mode: ${status.operationMode})`);

      // Update all characteristics
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState,
        this.mapToCurrentHeatingCoolingState(status),
      );

      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState,
        this.mapToTargetHeatingCoolingState(status),
      );

      // Only update temperature if valid
      if (status.roomTemp !== undefined && status.roomTemp !== null && !isNaN(status.roomTemp)) {
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentTemperature,
          status.roomTemp,
        );
      }

      const targetTemp = this.getTargetTempFromStatus(status);
      if (targetTemp !== undefined && targetTemp !== null && !isNaN(targetTemp)) {
        // Log temperature returned from API for comparison
        const targetTempF = (targetTemp * 9/5) + 32;
        this.platform.log.info(`[TEMP UPDATE] ${this.accessory.displayName}: API returned target ${targetTemp.toFixed(3)}°C (${targetTempF.toFixed(1)}°F) [mode: ${status.operationMode}]`);

        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetTemperature,
          targetTemp,
        );
      }

      // Only update humidity if the device has a humidity sensor
      if (this.hasHumiditySensor && status.humidity !== null) {
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentRelativeHumidity,
          status.humidity,
        );
      }
    } catch (error) {
      this.platform.log.error('Error updating device status:', error);
    }
  }

  private mapToCurrentHeatingCoolingState(status: DeviceStatus): number {
    // If power is off, always return OFF
    if (status.power === 0) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    // Map operation mode to HomeKit state
    switch (status.operationMode) {
      case 'heat':
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      case 'cool':
        return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      case 'auto':
        // For auto mode, we need to determine if it's currently heating or cooling
        // based on target vs current temperature
        const targetTemp = this.getTargetTempFromStatus(status);
        if (status.roomTemp < targetTemp) {
          return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        } else if (status.roomTemp > targetTemp) {
          return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
        }
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      case 'off':
      default:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  private mapToTargetHeatingCoolingState(status: DeviceStatus): number {
    // If power is off, return OFF
    if (status.power === 0 || status.operationMode === 'off') {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }

    // Map operation mode to HomeKit state
    switch (status.operationMode) {
      case 'heat':
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      case 'cool':
        return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      case 'auto':
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      default:
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  private getTargetTempFromStatus(status: DeviceStatus): number {
    // Return the appropriate setpoint based on current mode
    if (status.operationMode === 'heat' && status.spHeat !== undefined && status.spHeat !== null) {
      return status.spHeat;
    } else if (status.operationMode === 'cool' && status.spCool !== undefined && status.spCool !== null) {
      return status.spCool;
    } else if (status.operationMode === 'auto' && status.spAuto !== null && status.spAuto !== undefined) {
      return status.spAuto;
    }
    // Default to heat setpoint if available, otherwise return a default value
    if (status.spHeat !== undefined && status.spHeat !== null) {
      return status.spHeat;
    }
    // Final fallback
    return 20;
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    if (!this.currentStatus) {
      // If we don't have status yet, fetch it
      const status = await this.kumoAPI.getDeviceStatus(this.deviceSerial);
      if (status) {
        this.currentStatus = status;
      } else {
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      }
    }

    const state = this.mapToCurrentHeatingCoolingState(this.currentStatus);
    this.platform.log.debug('Get CurrentHeatingCoolingState:', state);
    return state;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    if (!this.currentStatus) {
      const status = await this.kumoAPI.getDeviceStatus(this.deviceSerial);
      if (status) {
        this.currentStatus = status;
      } else {
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
      }
    }

    const state = this.mapToTargetHeatingCoolingState(this.currentStatus);
    this.platform.log.debug('Get TargetHeatingCoolingState:', state);
    return state;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    this.platform.log.debug('Set TargetHeatingCoolingState:', value);

    let operationMode: 'off' | 'heat' | 'cool' | 'auto';

    switch (value) {
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        operationMode = 'off';
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        operationMode = 'heat';
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        operationMode = 'cool';
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        operationMode = 'auto';
        break;
      default:
        this.platform.log.error('Unknown target heating cooling state:', value);
        return;
    }

    const success = await this.kumoAPI.sendCommand(this.deviceSerial, {
      operationMode,
    });

    if (success) {
      // Optimistic update - immediately update local state
      if (this.currentStatus) {
        this.currentStatus.operationMode = operationMode;
        this.currentStatus.power = operationMode === 'off' ? 0 : 1;
      }

      // Note: Platform will update on next poll cycle (no per-device polling timer)
    } else {
      this.platform.log.error(`Failed to set target heating cooling state for ${this.accessory.displayName}`);
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    if (!this.currentStatus) {
      const status = await this.kumoAPI.getDeviceStatus(this.deviceSerial);
      if (status) {
        this.currentStatus = status;
      } else {
        this.platform.log.warn('No status available for getCurrentTemperature');
        return 20; // Default fallback temperature
      }
    }

    const temp = this.currentStatus.roomTemp;
    if (temp === undefined || temp === null || isNaN(temp)) {
      this.platform.log.warn('Invalid roomTemp value:', temp);
      return 20; // Default fallback temperature
    }

    this.platform.log.debug(`HomeKit get current temp for ${this.accessory.displayName}: ${temp}°C`);
    return temp;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    if (!this.currentStatus) {
      const status = await this.kumoAPI.getDeviceStatus(this.deviceSerial);
      if (status) {
        this.currentStatus = status;
      } else {
        this.platform.log.warn('No status available for getTargetTemperature');
        return 20; // Default fallback temperature
      }
    }

    const temp = this.getTargetTempFromStatus(this.currentStatus);
    if (temp === undefined || temp === null || isNaN(temp)) {
      this.platform.log.warn('Invalid target temperature value:', temp);
      return 20; // Default fallback temperature
    }

    this.platform.log.debug(`HomeKit get target temp for ${this.accessory.displayName}: ${temp}°C`);
    return temp;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    const temp = value as number;

    // Convert to Fahrenheit for logging
    const tempF = (temp * 9/5) + 32;
    this.platform.log.info(`[TEMP CHANGE] ${this.accessory.displayName}: HomeKit sent ${temp.toFixed(3)}°C (${tempF.toFixed(1)}°F)`);

    if (!this.currentStatus) {
      this.platform.log.error('Cannot set temperature - no current status');
      return;
    }

    // Set the appropriate setpoint based on current mode
    const commands: { spHeat?: number; spCool?: number } = {};

    if (this.currentStatus.operationMode === 'heat') {
      commands.spHeat = temp;
    } else if (this.currentStatus.operationMode === 'cool') {
      commands.spCool = temp;
    } else if (this.currentStatus.operationMode === 'auto') {
      // For auto mode, set both setpoints
      commands.spHeat = temp;
      commands.spCool = temp;
    } else {
      // If off, set heat setpoint by default
      commands.spHeat = temp;
    }

    this.platform.log.info(`[TEMP CHANGE] ${this.accessory.displayName}: Sending to API: ${JSON.stringify(commands)}°C`);

    const success = await this.kumoAPI.sendCommand(this.deviceSerial, commands);

    if (success) {
      this.platform.log.info(`[TEMP CHANGE] ${this.accessory.displayName}: Command accepted by API`);

      // Optimistic update - immediately update local state
      if (this.currentStatus) {
        if (commands.spHeat !== undefined) {
          this.currentStatus.spHeat = commands.spHeat;
        }
        if (commands.spCool !== undefined) {
          this.currentStatus.spCool = commands.spCool;
        }
      }

      // Immediately notify HomeKit of the new value
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetTemperature,
        temp,
      );

      // Note: Platform will update on next poll cycle (no per-device polling timer)
    } else {
      this.platform.log.error(`Failed to set target temperature for ${this.accessory.displayName}: ${JSON.stringify(commands)}`);
    }
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    // Default to Celsius
    return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    this.platform.log.debug('Set TemperatureDisplayUnits:', value);
    // We don't actually need to do anything here as the API uses Celsius
  }

  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    if (!this.currentStatus) {
      const status = await this.kumoAPI.getDeviceStatus(this.deviceSerial);
      if (status) {
        this.currentStatus = status;
      }
    }

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
