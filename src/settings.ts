export const PLATFORM_NAME = 'KumoV3';
export const PLUGIN_NAME = 'homebridge-mitsubishi-comfort';
export const API_BASE_URL = 'https://app-prod.kumocloud.com/v3';
export const SOCKET_BASE_URL = 'https://socket-prod.kumocloud.com';
export const TOKEN_REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes
export const POLL_INTERVAL = 30 * 1000; // 30 seconds
export const APP_VERSION = '3.2.3';

export interface KumoConfig {
  platform: string;
  name?: string;
  username: string;
  password: string;
  pollInterval?: number;
  debug?: boolean;
  excludeDevices?: string[];
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
}

export interface Commands {
  spHeat?: number;
  spCool?: number;
  operationMode?: 'off' | 'heat' | 'cool' | 'auto' | 'vent' | 'dry';
  fanSpeed?: 'auto' | 'low' | 'medium' | 'high';
}

export interface SendCommandRequest {
  deviceSerial: string;
  commands: Commands;
}

export interface SendCommandResponse {
  devices: string[]; // Array of device serial numbers that received the command
}
