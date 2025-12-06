import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { KumoV3Platform } from './platform';
import { KumoAPI } from './kumo-api';
import { POLL_INTERVAL, DeviceStatus } from './settings';

export class KumoThermostatAccessory {
  private service: Service;
  private pollTimer: NodeJS.Timeout | null = null;

  private deviceSerial: string;
  private siteId: string;
  private currentStatus: DeviceStatus | null = null;
  private pollIntervalMs: number;

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

    // Optional: Add humidity characteristic if available
    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    // Start polling for status updates
    this.startPolling();
  }

  private startPolling() {
    // Do an immediate update
    this.updateStatus();

    // Then poll at regular intervals
    this.pollTimer = setInterval(() => {
      this.updateStatus();
    }, this.pollIntervalMs);
  }

  private async updateStatus() {
    try {
      // Fetch zones for this device's site with ETag support
      const result = await this.kumoAPI.getZonesWithETag(this.siteId);

      // If not modified (304), keep existing status
      if (result.notModified) {
        this.platform.log.debug(`Status not modified for device ${this.deviceSerial}`);
        return;
      }

      // Find this device's zone in the results
      const zone = result.zones.find(z => z.adapter.deviceSerial === this.deviceSerial);
      if (!zone) {
        this.platform.log.error(`Device ${this.deviceSerial} not found in zones response`);
        return;
      }

      // Validate required fields
      if (zone.adapter.roomTemp === undefined || zone.adapter.roomTemp === null) {
        this.platform.log.error(`Device ${this.deviceSerial} has invalid roomTemp: ${zone.adapter.roomTemp}`);
        this.platform.log.debug('Zone adapter data:', JSON.stringify(zone.adapter));
        return;
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
      this.platform.log.debug(`Updated status for ${this.deviceSerial}: roomTemp=${status.roomTemp}, mode=${status.operationMode}`);

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
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetTemperature,
          targetTemp,
        );
      }

      if (status.humidity !== null) {
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
    if (status.operationMode === 'heat') {
      return status.spHeat;
    } else if (status.operationMode === 'cool') {
      return status.spCool;
    } else if (status.operationMode === 'auto' && status.spAuto !== null) {
      return status.spAuto;
    }
    // Default to heat setpoint
    return status.spHeat;
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
      // Update status immediately after successful command
      setTimeout(() => this.updateStatus(), 1000);
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

    this.platform.log.debug('Get CurrentTemperature:', temp);
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

    this.platform.log.debug('Get TargetTemperature:', temp);
    return temp;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    const temp = value as number;
    this.platform.log.debug('Set TargetTemperature:', temp);

    if (!this.currentStatus) {
      this.platform.log.error('Cannot set temperature - no current status');
      return;
    }

    // Round to nearest 0.5°C as Kumo API uses 0.5 degree increments
    const roundedTemp = Math.round(temp * 2) / 2;
    this.platform.log.debug(`Rounded temperature from ${temp} to ${roundedTemp}`);

    // Set the appropriate setpoint based on current mode
    const commands: { spHeat?: number; spCool?: number } = {};

    if (this.currentStatus.operationMode === 'heat') {
      commands.spHeat = roundedTemp;
    } else if (this.currentStatus.operationMode === 'cool') {
      commands.spCool = roundedTemp;
    } else if (this.currentStatus.operationMode === 'auto') {
      // For auto mode, set both setpoints
      commands.spHeat = roundedTemp;
      commands.spCool = roundedTemp;
    } else {
      // If off, set heat setpoint by default
      commands.spHeat = roundedTemp;
    }

    const success = await this.kumoAPI.sendCommand(this.deviceSerial, commands);

    if (success) {
      // Update status immediately after successful command
      setTimeout(() => this.updateStatus(), 1000);
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
