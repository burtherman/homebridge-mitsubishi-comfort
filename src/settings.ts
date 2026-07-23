export const PLATFORM_NAME = 'KumoV3';
export const PLUGIN_NAME = 'homebridge-mitsubishi-comfort';
export const API_BASE_URL = 'https://app-prod.kumocloud.com/v3';
export const SOCKET_BASE_URL = 'https://socket-prod.kumocloud.com';
export const TOKEN_REFRESH_INTERVAL = 20 * 60 * 1000; // 20 minutes (actual token lifetime)
export const POLL_INTERVAL = 30 * 1000; // 30 seconds
export const APP_VERSION = '3.2.4';

export interface KumoConfig {
  platform: string;
  name?: string;
  username: string;
  password: string;
  pollInterval?: number;
  disablePolling?: boolean;
  debug?: boolean;
  excludeDevices?: string[];
  streamingHealthCheckInterval?: number;
  streamingStaleThreshold?: number;
  degradedPollInterval?: number;
  // Local LAN control (opt-in). When true, the plugin discovers each unit's IP on
  // the LAN and controls/reads it directly, falling back to cloud per-unit when a
  // unit is unreachable. Cloud streaming stays connected as the fallback.
  localControl?: boolean;
  // Optional manual serial -> IP overrides (skip discovery for these units).
  localControlIps?: Record<string, string>;
  // Seconds between local status polls (default 15).
  localPollInterval?: number;
  // Device mirroring (opt-in). Each pair makes `target` follow `source`: whenever
  // the source's commanded state changes (via any control path — wall thermostat,
  // Kumo app, or HomeKit), the source's full state is pushed to the target. One-way;
  // a manual change to the target persists until the next source change re-syncs it.
  mirror?: MirrorPair[];
}

/** A one-way mirror: `target` follows `source` (both device serials). */
export interface MirrorPair {
  source: string;
  target: string;
}

/**
 * The subset of a device's state the mirror copies from source to target.
 * `operationMode` is the raw status value (may be autoHeat/autoCool); `fanSpeed`
 * is the raw adapter/cloud fan-speed string (mirrored verbatim).
 */
export interface MirrorState {
  operationMode: string;
  power: number;
  spHeat: number;
  spCool: number;
  fanSpeed: string;
}

export interface LoginResponse {
  id: string;
  username: string;
  email: string;
  token: {
    access: string;
    refresh: string;
  };
  preferences?: Record<string, unknown>;
}

export interface Site {
  id: string;
  name: string;
}

export interface Zone {
  id: string;
  name: string;
  isActive: boolean;
  adapter: Adapter;
}

export interface Adapter {
  id: string;
  deviceSerial: string;
  roomTemp: number;
  spHeat: number;
  spCool: number;
  spAuto: number | null;
  humidity: number | null;
  power: number;
  operationMode: string;
  previousOperationMode: string;
  fanSpeed: string;
  airDirection: string;
  connected: boolean;
  isSimulator: boolean;
  hasSensor: boolean;
  hasMhk2: boolean;
  scheduleOwner: string;
  scheduleHoldEndTime: number;
  rssi?: number;
}

export interface DeviceStatus {
  id: string;
  deviceSerial: string;
  rssi: number;
  power: number;
  operationMode: string;
  humidity: number | null;
  fanSpeed: string;
  airDirection: string;
  roomTemp: number;
  spCool: number;
  spHeat: number;
  spAuto: number | null;
  // Extended fields from device_update streaming
  modelNumber?: string;
  connected?: boolean;
  standby?: boolean;
  defrost?: boolean;
  filterDirty?: boolean;
}

export interface DeviceProfile {
  numberOfFanSpeeds: number;
  hasFanSpeedAuto: boolean;
  hasModeDry: boolean;
  // Dry mode holds its setpoint in spCool on the Kumo v3 cloud (there is no
  // spDry field). When true, dry has a settable target; when false the unit
  // dehumidifies at a fixed setpoint and ignores writes. See accessory.ts.
  usesSetPointInDryMode: boolean;
  hasModeHeat: boolean;
  hasModeVent: boolean;
  hasVaneDir: boolean;
  hasVaneSwing: boolean;
  hasDefrost: boolean;
  hasStandby: boolean;
  minimumSetPoints: { cool: number; heat: number; auto: number };
  maximumSetPoints: { cool: number; heat: number; auto: number };
}

export interface Commands {
  spHeat?: number;
  spCool?: number;
  operationMode?: 'off' | 'heat' | 'cool' | 'auto' | 'vent' | 'dry';
  fanSpeed?: 'auto' | 'low' | 'medium' | 'high';
  // A verbatim adapter/cloud fan-speed string (e.g. 'quiet', 'powerful'). Used by
  // the mirror path to copy a fan speed faithfully without collapsing it through
  // the coarse `fanSpeed` enum. Takes precedence over `fanSpeed` on the local path;
  // folded into `fanSpeed` on the cloud path (see toCloudCommands).
  fanSpeedRaw?: string;
  power?: 0 | 1;
}

export interface SendCommandRequest {
  deviceSerial: string;
  commands: Commands;
}

export interface SendCommandResponse {
  devices: string[]; // Array of device serial numbers that received the command
}
