import fetch, { RequestInit } from 'node-fetch';
import type { Logger } from 'homebridge';
import {
  API_BASE_URL,
  APP_VERSION,
  TOKEN_REFRESH_INTERVAL,
  LoginResponse,
  Site,
  Zone,
  DeviceStatus,
  Commands,
  SendCommandRequest,
  SendCommandResponse,
} from './settings';

export class KumoAPI {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private siteEtags: Map<string, string> = new Map();
  private debugMode: boolean = false;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
    debug: boolean = false,
  ) {
    this.debugMode = debug;
    if (this.debugMode) {
      this.log.info('Debug mode enabled');
    }
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
        this.log.error(`Login failed with status: ${response.status}`);
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
      this.log.error('Login error:', error);
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
          'Authorization': `Bearer ${this.refreshToken}`,
          'X-App-Version': APP_VERSION,
        },
      });

      if (!response.ok) {
        this.log.warn('Token refresh failed, attempting full login');
        return await this.login();
      }

      const data = await response.json() as LoginResponse;

      this.accessToken = data.token.access;
      this.refreshToken = data.token.refresh;
      this.tokenExpiresAt = Date.now() + TOKEN_REFRESH_INTERVAL;

      this.log.debug('Access token refreshed successfully');

      // Schedule next refresh
      this.scheduleTokenRefresh();

      return true;
    } catch (error) {
      this.log.error('Token refresh error:', error);
      return await this.login();
    }
  }

  private async ensureAuthenticated(): Promise<boolean> {
    // If no token or token is about to expire, refresh it
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - (5 * 60 * 1000)) {
      if (!this.refreshToken) {
        return await this.login();
      }
      return await this.refreshAccessToken();
    }
    return true;
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
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-App-Version': APP_VERSION,
        },
      };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(`${API_BASE_URL}${endpoint}`, options);

      // Handle 401 by refreshing token and retrying once
      if (response.status === 401) {
        this.log.debug('Received 401, refreshing token and retrying');
        const refreshed = await this.refreshAccessToken();
        if (!refreshed) {
          return null;
        }

        // Retry request with new token
        options.headers = {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-App-Version': APP_VERSION,
        };

        const retryResponse = await fetch(`${API_BASE_URL}${endpoint}`, options);
        if (!retryResponse.ok) {
          this.log.error(`Request failed after retry: ${retryResponse.status}`);
          return null;
        }

        return await retryResponse.json() as T;
      }

      if (!response.ok) {
        this.log.error(`Request failed with status: ${response.status}`);
        return null;
      }

      return await response.json() as T;
    } catch (error) {
      this.log.error('Request error:', error);
      return null;
    }
  }

  async getSites(): Promise<Site[]> {
    this.log.debug('Fetching sites');
    const sites = await this.makeAuthenticatedRequest<Site[]>('/sites');
    return sites || [];
  }

  async getZones(siteId: string): Promise<Zone[]> {
    this.log.debug(`Fetching zones for site: ${siteId}`);
    const zones = await this.makeAuthenticatedRequest<Zone[]>(`/sites/${siteId}/zones`);
    return zones || [];
  }

  async getZonesWithETag(siteId: string): Promise<{ zones: Zone[]; notModified: boolean }> {
    const etag = this.siteEtags.get(siteId);
    
    // Ensure we have a valid token
    const authenticated = await this.ensureAuthenticated();
    if (!authenticated) {
      this.log.error('Failed to authenticate');
      return { zones: [], notModified: false };
    }

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/json',
        'X-App-Version': APP_VERSION,
      };

      if (etag) {
        headers['If-None-Match'] = etag;
      }

      const response = await fetch(`${API_BASE_URL}/sites/${siteId}/zones`, { headers });

      // Handle 304 Not Modified
      if (response.status === 304) {
        this.log.debug(`Zones for site ${siteId}: Not Modified (304)`);
        return { zones: [], notModified: true };
      }

      if (!response.ok) {
        this.log.error(`Failed to fetch zones for site ${siteId}: ${response.status}`);
        return { zones: [], notModified: false };
      }

      // Store new ETag
      const newEtag = response.headers.get('etag');
      if (newEtag) {
        this.siteEtags.set(siteId, newEtag);
      }

      const zones = await response.json() as Zone[];
      return { zones, notModified: false };
    } catch (error) {
      this.log.error('Error fetching zones with ETag:', error);
      return { zones: [], notModified: false };
    }
  }

  async getDeviceStatus(deviceSerial: string): Promise<DeviceStatus | null> {
    this.log.debug(`Fetching status for device: ${deviceSerial}`);
    return await this.makeAuthenticatedRequest<DeviceStatus>(`/devices/${deviceSerial}/status`);
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

    if (!response.success) {
      this.log.error(`Send command failed: API returned success=false for device ${deviceSerial}`);
      return false;
    }

    this.log.debug(`Command sent successfully to device ${deviceSerial}`);
    return true;
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
