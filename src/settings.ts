export const PLATFORM_NAME = 'KumoV3';
export const PLUGIN_NAME = 'homebridge-mitsubishi-comfort';
export const API_BASE_URL = 'https://app-prod.kumocloud.com/v3';
export const SOCKET_BASE_URL = 'https://socket-prod.kumocloud.com';
// The LEGACY v2 cloud API — pykumo / Home Assistant's data source. Its login
// response still includes every adapter's local password + cryptoSerial, which
// v3 only delivers over the Socket.IO `adapter_update` push. Used as a fallback
// credential source when the push doesn't deliver (see fetchLegacyCredentials).
export const LEGACY_API_BASE_URL = 'https://geo-c.kumocloud.com';
export const LEGACY_APP_VERSION = '2.2.0';
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

// ---- Vane and fan-speed vocabularies --------------------------------------
// Portions derived from homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0,
// src/settings.ts @ 83dfd18), modified.
//
// Both lists were verified by write test on the fork author's four units
// (MLZ-KX06NL-U1 x2, MLZ-KX12NL-U1, MSZ-GX06NL-U1): the local adapter accepted every
// value. They are the ONLY validation layer: the adapter answers HTTP 200 to
// `vaneDir:"notARealVane"` and silently ignores it, so a typo is an invisible no-op.
// Validate (isVaneDirection / isFanSpeed) before every write.

/**
 * Vane (louver) positions in physical order: 'horizontal' is the flattest blade
 * angle, 'vertical' the most downward, with three steps between. 'auto' (unit
 * decides) and 'swing' (continuous sweep) aren't fixed angles.
 */
export type VaneDirection =
  | 'auto'
  | 'horizontal'
  | 'midhorizontal'
  | 'midpoint'
  | 'midvertical'
  | 'vertical'
  | 'swing';

export const VANE_DIRECTIONS: readonly VaneDirection[] = [
  'auto',
  'horizontal',
  'midhorizontal',
  'midpoint',
  'midvertical',
  'vertical',
  'swing',
];

export function isVaneDirection(v: unknown): v is VaneDirection {
  return typeof v === 'string' && (VANE_DIRECTIONS as readonly string[]).includes(v);
}

/** Named fan speeds the adapter accepts. */
export type FanSpeed = 'auto' | 'superQuiet' | 'quiet' | 'low' | 'powerful' | 'superPowerful';

/**
 * Indices 1..5 are the airflow ladder in ascending order. 'auto' (index 0) is "let
 * the unit decide", not an airflow level, so anything mapping speeds onto a slider
 * must rank only `FAN_SPEEDS.slice(1)`.
 *
 * The profile's `numberOfFanSpeeds` is advisory and must not gate this list: on the
 * fork author's units, one reporting 3 accepted all five named speeds.
 */
export const FAN_SPEEDS: readonly FanSpeed[] = [
  'auto',
  'superQuiet',
  'quiet',
  'low',
  'powerful',
  'superPowerful',
];

export function isFanSpeed(v: unknown): v is FanSpeed {
  return typeof v === 'string' && (FAN_SPEEDS as readonly string[]).includes(v);
}

/**
 * Match a fan speed REPORTED by a unit against the vocabulary, ignoring case.
 * Read path only: pykumo lists both `low` and `Low`, and some units report the
 * capitalised form. Writes go out in the canonical lower-camel form.
 *
 * Returns undefined for an unknown speed. Callers must not treat that as 'auto',
 * which would misreport the unit's real state.
 */
export function normalizeFanSpeed(v: unknown): FanSpeed | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }
  const lower = v.toLowerCase();
  return FAN_SPEEDS.find((f) => f.toLowerCase() === lower);
}

export interface Commands {
  spHeat?: number;
  spCool?: number;
  operationMode?: 'off' | 'heat' | 'cool' | 'auto' | 'vent' | 'dry';
  // Was a coarse 'auto'|'low'|'medium'|'high' enum, translated by a lossy mapping in
  // local-api.ts (coarse 'low' meant the adapter's 'quiet'). Nothing ever produced it:
  // every fan write so far is the mirror's `fanSpeedRaw`. Now the adapter's own
  // vocabulary, validated at both write boundaries.
  fanSpeed?: FanSpeed;
  // A verbatim fan-speed string copied from a source unit by the mirror. Not
  // validated: the source reported it, so the hardware produces it, even if it's a
  // value FAN_SPEEDS doesn't list. Takes precedence over `fanSpeed` on the local path;
  // folded into `fanSpeed` on the cloud path (see toCloudCommands).
  fanSpeedRaw?: string;
  // Vane/louver position. The local field is `vaneDir`; the cloud calls the same
  // thing `airDirection` (translated in toCloudCommands).
  vaneDir?: VaneDirection;
  power?: 0 | 1;
}

/**
 * The cloud wire shape for `POST /devices/send-command`. Not `Commands`: the cloud
 * names the vane field `airDirection` and has no `fanSpeedRaw`. toCloudCommands
 * translates.
 */
export interface CloudCommands {
  spHeat?: number;
  spCool?: number;
  operationMode?: Commands['operationMode'];
  // Verbatim, not narrowed to FanSpeed: a mirrored value may be one FAN_SPEEDS
  // doesn't list, and the cloud accepts whatever the unit reported.
  fanSpeed?: string;
  airDirection?: VaneDirection;
  power?: 0 | 1;
}

export interface SendCommandRequest {
  deviceSerial: string;
  commands: CloudCommands;
}

export interface SendCommandResponse {
  devices: string[]; // Array of device serial numbers that received the command
}
