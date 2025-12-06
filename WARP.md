# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview
Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API. The plugin exposes heat pumps as HomeKit thermostats with support for Heat, Cool, Auto, and Off modes.

## Common Commands

### Build and Development
```bash
# Build TypeScript to JavaScript
npm run build

# Watch mode - builds, links plugin, and restarts on changes
npm run watch

# Install from source
npm install
npm run build
npm link
```

### Testing
```bash
# Test API connectivity without Homebridge (standalone script)
node test-api.js <username> <password>
```

No formal test suite exists. Use `test-api.js` to verify API connectivity and credentials.

## Architecture

### Component Flow
1. **Platform** (`platform.ts`) - Entry point that orchestrates discovery and accessory registration
2. **API Client** (`kumo-api.ts`) - Handles authentication, token refresh, and all API communication
3. **Accessory** (`accessory.ts`) - Implements HomeKit thermostat service and state management for each device

### Key Concepts

#### Authentication Flow
- Initial login via POST `/v3/login` with username/password
- Access tokens expire in ~20 minutes
- Automatic token refresh runs every 15 minutes (via `scheduleTokenRefresh()`)
- 401 responses trigger immediate token refresh with automatic retry

#### Device Discovery
Platform discovers devices on Homebridge startup:
1. Login to Kumo Cloud API
2. Fetch all sites (`/v3/sites`)
3. For each site, fetch zones (`/v3/sites/{siteId}/zones`)
4. Register each active zone as a HomeKit thermostat accessory
5. Remove stale accessories no longer present in Kumo Cloud

#### Status Polling
Each accessory polls zones data every 30 seconds (`POLL_INTERVAL`) to keep HomeKit synchronized with physical device state. Uses ETag-based caching to minimize bandwidth - if no changes (304 Not Modified), existing state is preserved. Updates all characteristics including temperature, mode, and humidity.

#### Mode Mapping
Kumo modes (`off`, `heat`, `cool`, `auto`) map to HomeKit's `TargetHeatingCoolingState`. The `auto` mode uses different logic:
- For `CurrentHeatingCoolingState`: determines HEAT/COOL based on room temp vs target temp
- For `TargetHeatingCoolingState`: maps directly to AUTO

#### Temperature Setpoints
Device maintains separate setpoints for each mode:
- `spHeat` - heating setpoint
- `spCool` - cooling setpoint  
- `spAuto` - auto mode setpoint (may be null)

Accessory returns appropriate setpoint based on current operation mode.

### Configuration
Plugin configured via Homebridge `config.json`:
```json
{
  "platforms": [{
    "platform": "KumoV3",
    "name": "Kumo",
    "username": "your-email@example.com",
    "password": "your-password"
  }]
}
```

## API Details
- Base URL: `https://app-prod.kumocloud.com/v3`
- All authenticated requests require `Authorization: Bearer {access_token}` header
- Key endpoints:
  - `POST /v3/login` - Authentication
  - `GET /v3/sites` - Get all sites
  - `GET /v3/sites/{siteId}/zones` - Get zones per site
  - `GET /v3/devices/{deviceSerial}/status` - Get device status
  - `POST /v3/devices/send-command` - Send commands to device

See `kumo-v3-spec.md` for complete API documentation including request/response schemas.

## Important Constants
- `TOKEN_REFRESH_INTERVAL`: 15 minutes (900,000ms)
- `POLL_INTERVAL`: 30 seconds (30,000ms)
- `APP_VERSION`: '3.2.3' (required for API authentication)
