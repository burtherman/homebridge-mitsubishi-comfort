import fetch, { RequestInit } from 'node-fetch';
import type { Logger } from 'homebridge';
import { io, Socket } from 'socket.io-client';
import {
  API_BASE_URL,
  APP_VERSION,
  TOKEN_REFRESH_INTERVAL,
  SOCKET_BASE_URL,
  LoginResponse,
  Site,
  Zone,
  DeviceStatus,
  Commands,
  SendCommandRequest,
  SendCommandResponse,
} from './settings';

// Event callback type for device updates
export type DeviceUpdateCallback = (deviceSerial: string, status: Partial<DeviceStatus>) => void;

export class KumoAPI {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private debugMode: boolean = false;
  private refreshInProgress: Promise<boolean> | null = null;

  // Streaming properties
  private socket: Socket | null = null;
  private streamingEnabled: boolean = true;
  private deviceUpdateCallbacks: Map<string, DeviceUpdateCallback> = new Map();
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
    debug: boolean = false,
    enableStreaming: boolean = true,
  ) {
    this.debugMode = debug;
    this.streamingEnabled = enableStreaming;
    if (this.debugMode) {
      this.log.info('Debug mode enabled');
      this.log.warn('Debug mode may log sensitive information - use only for troubleshooting');
    }
    if (this.streamingEnabled) {
      this.log.info('Streaming mode enabled - real-time updates will be used');
    }
  }

  private maskToken(token: string | null): string {
    if (!token) {
      return 'null';
    }
    if (token.length <= 8) {
      return '***';
    }
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  }

  async login(): Promise<boolean> {
    try {
      this.log.debug('Attempting to login to Kumo Cloud API');

      const response = await fetch(`${API_BASE_URL}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-App-Version': APP_VERSION,
        },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
          appVersion: APP_VERSION,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log.error(`Login failed with status: ${response.status}`);
        // Only log response body in debug mode, as it may contain sensitive info
        if (this.debugMode && errorText) {
          this.log.debug(`Login error response: ${errorText}`);
        }
        return false;
      }

      const data = await response.json() as LoginResponse;

      this.accessToken = data.token.access;
      this.refreshToken = data.token.refresh;


      // JWT tokens typically expire in 20 minutes, we'll refresh at 15 minutes
      this.tokenExpiresAt = Date.now() + TOKEN_REFRESH_INTERVAL;

      this.log.info('Successfully logged in to Kumo Cloud API');

      // Set up automatic token refresh
      this.scheduleTokenRefresh();

      return true;
    } catch (error) {
      if (error instanceof Error) {
        this.log.error('Login error:', error.message);
        if (this.debugMode) {
          this.log.debug('Login error stack:', error.stack);
        }
      } else {
        this.log.error('Login error: Unknown error occurred');
      }
      return false;
    }
  }

  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    // Schedule refresh 5 minutes before expiry (TOKEN_REFRESH_INTERVAL is 15 min, so this is at ~10 min mark)
    const refreshIn = TOKEN_REFRESH_INTERVAL - (5 * 60 * 1000);

    this.refreshTimer = setTimeout(async () => {
      this.log.debug('Refreshing access token');
      await this.refreshAccessToken();
    }, refreshIn);
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) {
      this.log.error('No refresh token available, need to login again');
      return await this.login();
    }

    try {
      this.log.debug('Refreshing access token');

      const response = await fetch(`${API_BASE_URL}/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-App-Version': APP_VERSION,
        },
        body: JSON.stringify({
          refresh: this.refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log.warn(`Token refresh failed (${response.status}): ${errorText}`);
        this.log.warn('Attempting full login');
        return await this.login();
      }

      const data = await response.json() as any;

      // The refresh endpoint returns tokens directly, not nested under 'token'
      this.accessToken = data.access;
      this.refreshToken = data.refresh;
      this.tokenExpiresAt = Date.now() + TOKEN_REFRESH_INTERVAL;

      this.log.debug('Access token refreshed successfully');

      // Schedule next refresh
      this.scheduleTokenRefresh();

      return true;
    } catch (error) {
      if (error instanceof Error) {
        this.log.error('Token refresh error:', error.message);
      } else {
        this.log.error('Token refresh error: Unknown error occurred');
      }
      return await this.login();
    }
  }

  private async ensureAuthenticated(): Promise<boolean> {
    // If no token or token is about to expire, refresh it
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - (5 * 60 * 1000)) {
      // If a refresh is already in progress, wait for it instead of starting a new one
      if (this.refreshInProgress) {
        this.log.debug('Waiting for existing token refresh to complete');
        return await this.refreshInProgress;
      }

      // Start a new refresh and store the promise
      this.refreshInProgress = (async () => {
        try {
          if (!this.refreshToken) {
            return await this.login();
          }
          return await this.refreshAccessToken();
        } finally {
          // Clear the lock when done
          this.refreshInProgress = null;
        }
      })();

      return await this.refreshInProgress;
    }
    return true;
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-App-Version': APP_VERSION,
    };
  }

  private async makeAuthenticatedRequest<T>(
    endpoint: string,
    method: string = 'GET',
    body?: unknown,
  ): Promise<T | null> {
    // Ensure we have a valid token
    const authenticated = await this.ensureAuthenticated();
    if (!authenticated) {
      this.log.error('Failed to authenticate');
      return null;
    }

    try {
      const options: RequestInit = {
        method,
        headers: this.getAuthHeaders(),
      };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const url = `${API_BASE_URL}${endpoint}`;

      // Debug logging: Show request details
      if (this.debugMode) {
        this.log.info(`→ API Request: ${method} ${endpoint}`);
        if (body) {
          this.log.info(`  Body: ${JSON.stringify(body)}`);
        }
      }

      const startTime = Date.now();
      const response = await fetch(url, options);
      const duration = Date.now() - startTime;

      // Handle 401 by refreshing token and retrying once
      if (response.status === 401) {
        this.log.debug('Received 401, refreshing token and retrying');
        const refreshed = await this.refreshAccessToken();
        if (!refreshed) {
          return null;
        }

        // Retry request with new token
        options.headers = this.getAuthHeaders();
        const retryResponse = await fetch(`${API_BASE_URL}${endpoint}`, options);
        if (!retryResponse.ok) {
          this.log.error(`Request failed after retry: ${retryResponse.status}`);
          return null;
        }

        return await retryResponse.json() as T;
      }

      if (!response.ok) {
        this.log.error(`Request failed with status: ${response.status}`);
        if (this.debugMode) {
          const errorText = await response.text();
          this.log.info(`  Error response: ${errorText}`);
        }
        return null;
      }

      const data = await response.json() as T;

      // Debug logging: Show response summary
      if (this.debugMode) {
        this.log.info(`← API Response: ${response.status} (${duration}ms)`);
        // For array responses, show count; for objects, show keys
        if (Array.isArray(data)) {
          this.log.info(`  Returned ${data.length} item(s)`);
        } else if (data && typeof data === 'object') {
          this.log.info(`  Keys: ${Object.keys(data).join(', ')}`);
        }
      }

      return data;
    } catch (error) {
      // Log errors without exposing sensitive details
      if (error instanceof Error) {
        this.log.error('Request error:', error.message);
        if (this.debugMode) {
          this.log.debug('Full error stack:', error.stack);
        }
      } else {
        this.log.error('Request error: Unknown error occurred');
      }
      return null;
    }
  }

  async getSites(): Promise<Site[]> {
    this.log.debug('Fetching sites');
    const sites = await this.makeAuthenticatedRequest<Site[]>('/sites');
    return sites || [];
  }

  async getZones(siteId: string): Promise<Zone[]> {
    // Ensure we have a valid token
    const authenticated = await this.ensureAuthenticated();
    if (!authenticated) {
      this.log.error('Failed to authenticate');
      return [];
    }

    try {
      const endpoint = `/sites/${siteId}/zones`;

      // Debug logging: Show request details
      if (this.debugMode) {
        this.log.info(`→ API Request: GET ${endpoint}`);
      }

      const startTime = Date.now();
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        headers: this.getAuthHeaders(),
      });
      const duration = Date.now() - startTime;

      if (!response.ok) {
        const errorBody = await response.text();
        this.log.error(`Failed to fetch zones for site ${siteId}: ${response.status} - ${errorBody}`);
        return [];
      }

      const zones = await response.json() as Zone[];

      // Debug logging: Show response details
      if (this.debugMode) {
        this.log.info(`← API Response: 200 (${duration}ms)`);
        this.log.info(`  Fetched ${zones.length} zone(s) for site ${siteId}`);

        // Log raw JSON for each zone to see all available fields
        zones.forEach(zone => {
          this.log.info(`  RAW Zone JSON for ${zone.name}:`);
          this.log.info(JSON.stringify(zone, null, 2));
        });

        zones.forEach(zone => {
          const a = zone.adapter;
          this.log.info(`    ${zone.name} [${a.deviceSerial}]`);
          this.log.info(`      Temperature: ${a.roomTemp}°C (current) → Heat: ${a.spHeat}°C, Cool: ${a.spCool}°C, Auto: ${a.spAuto}°C`);
          this.log.info(`      Status: ${a.operationMode} mode, power=${a.power}, connected=${a.connected}`);
          this.log.info(`      Fan: ${a.fanSpeed}, Direction: ${a.airDirection}, Humidity: ${a.humidity !== null ? a.humidity + '%' : 'N/A'}`);
          this.log.info(`      Signal: ${a.rssi !== undefined ? a.rssi + ' dBm' : 'N/A'}`);
        });
      }

      return zones;
    } catch (error) {
      if (error instanceof Error) {
        this.log.error('Error fetching zones:', error.message);
      } else {
        this.log.error('Error fetching zones: Unknown error occurred');
      }
      return [];
    }
  }

  async getDeviceStatus(deviceSerial: string): Promise<DeviceStatus | null> {
    this.log.debug(`Fetching status for device: ${deviceSerial}`);
    const status = await this.makeAuthenticatedRequest<DeviceStatus>(`/devices/${deviceSerial}/status`);

    // Log raw JSON to see all available fields
    if (this.debugMode && status) {
      this.log.info(`  RAW Device Status JSON for ${deviceSerial}:`);
      this.log.info(JSON.stringify(status, null, 2));
    }

    return status;
  }

  async sendCommand(deviceSerial: string, commands: Commands): Promise<boolean> {
    this.log.debug(`Sending command to device ${deviceSerial}:`, JSON.stringify(commands));

    const request: SendCommandRequest = {
      deviceSerial,
      commands,
    };

    const response = await this.makeAuthenticatedRequest<SendCommandResponse>(
      '/devices/send-command',
      'POST',
      request,
    );

    if (!response) {
      this.log.error(`Send command failed: no response from API for device ${deviceSerial}`);
      return false;
    }

    // The API returns { devices: ["serialNumber"] } on success
    if (!response.devices || !Array.isArray(response.devices)) {
      this.log.error(`Send command failed: unexpected response format for device ${deviceSerial}`);
      if (this.debugMode) {
        this.log.debug(`Response:`, JSON.stringify(response));
      }
      return false;
    }

    // Check if our device is in the response
    if (!response.devices.includes(deviceSerial)) {
      this.log.error(`Send command failed: device ${deviceSerial} not in response devices list`);
      return false;
    }

    this.log.debug(`Command sent successfully to device ${deviceSerial}`);
    return true;
  }

  // Streaming methods

  async startStreaming(deviceSerials: string[]): Promise<boolean> {
    if (!this.streamingEnabled) {
      this.log.debug('Streaming is disabled, skipping connection');
      return false;
    }

    if (this.socket?.connected) {
      this.log.debug('Streaming already connected');
      return true;
    }

    if (!this.accessToken) {
      this.log.error('Cannot start streaming: not authenticated');
      return false;
    }

    try {
      this.log.info('Starting streaming connection...');

      this.socket = io(SOCKET_BASE_URL, {
        transports: ['polling', 'websocket'],
        extraHeaders: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': '*/*',
          'User-Agent': 'kumocloud/1122',
        },
      });

      this.socket.on('connect', () => {
        this.log.info(`✓ Streaming connected (ID: ${this.socket?.id})`);
        this.reconnectAttempts = 0;

        // Subscribe to all devices
        for (const deviceSerial of deviceSerials) {
          this.log.debug(`Subscribing to device: ${deviceSerial}`);
          this.socket?.emit('subscribe', deviceSerial);
        }
      });

      this.socket.on('device_update', (data: any) => {
        const deviceSerial = data.deviceSerial;
        if (!deviceSerial) {
          return;
        }

        if (this.debugMode) {
          this.log.debug(`Stream update for ${deviceSerial}: temp=${data.roomTemp}°C, mode=${data.operationMode}, power=${data.power}`);
          // Log raw streaming update JSON to see all available fields
          this.log.info(`  RAW Streaming Update JSON for ${deviceSerial}:`);
          this.log.info(JSON.stringify(data, null, 2));
        }

        // Trigger callbacks for this device
        const callback = this.deviceUpdateCallbacks.get(deviceSerial);
        if (callback) {
          callback(deviceSerial, data);
        }
      });

      this.socket.on('disconnect', (reason) => {
        this.log.warn(`Streaming disconnected: ${reason}`);

        // Attempt to reconnect if not a manual disconnect
        if (reason !== 'io client disconnect' && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          this.log.info(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.log.error('Max reconnect attempts reached - falling back to polling');
        }
      });

      this.socket.on('connect_error', (error) => {
        this.log.error(`Streaming connection error: ${error.message}`);
      });

      return true;
    } catch (error) {
      if (error instanceof Error) {
        this.log.error('Failed to start streaming:', error.message);
      }
      return false;
    }
  }

  subscribeToDevice(deviceSerial: string, callback: DeviceUpdateCallback): void {
    this.deviceUpdateCallbacks.set(deviceSerial, callback);

    // If already connected, subscribe immediately
    if (this.socket?.connected) {
      this.log.debug(`Subscribing to device: ${deviceSerial}`);
      this.socket.emit('subscribe', deviceSerial);
    }
  }

  unsubscribeFromDevice(deviceSerial: string): void {
    this.deviceUpdateCallbacks.delete(deviceSerial);
  }

  isStreamingConnected(): boolean {
    return this.socket?.connected || false;
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.socket) {
      this.log.debug('Disconnecting streaming connection');
      this.socket.disconnect();
      this.socket = null;
    }
  }
}
