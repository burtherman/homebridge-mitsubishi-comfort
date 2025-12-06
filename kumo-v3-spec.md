# Homebridge Kumo v3 Plugin Specification

## Project Overview
Build a Homebridge plugin for Mitsubishi heat pumps using the new Kumo Cloud v3 API. This replaces the old plugin that used outdated endpoints.

## API Documentation

### Base URL
```
https://app-prod.kumocloud.com/v3
```

### Authentication

#### Login
```http
POST /v3/login
Content-Type: application/json

Request:
{
  "username": "email@example.com",
  "password": "password",
  "appVersion": "3.2.3"
}

Response:
{
  "id": "2251799814428278",
  "username": "email@example.com",
  "email": "email@example.com",
  "token": {
    "access": "eyJhbGc...",  // JWT - expires in ~20 minutes
    "refresh": "eyJhbGc..."  // JWT - for refreshing access token
  },
  "preferences": {...}
}
```

#### Required Headers for All Authenticated Requests
```
Authorization: Bearer {access_token}
Content-Type: application/json
Accept: application/json
```

### Device Discovery

#### 1. Get Sites
```http
GET /v3/sites
Authorization: Bearer {access_token}

Response:
[{
  "id": "adf9d44f-4fc9-41cc-97fb-b21bf3e60746",
  "name": "Home"
}]
```

#### 2. Get Zones (Rooms/Devices)
```http
GET /v3/sites/{siteId}/zones
Authorization: Bearer {access_token}

Response:
[{
  "id": "787dcd1e-d87d-4b9c-99c2-528319a418b4",
  "name": "Front bedroom",
  "isActive": true,
  "adapter": {
    "id": "99434d56-0da4-49a6-91de-2dffa3c3263d",
    "deviceSerial": "0Y34P008Q100142F",
    "isSimulator": false,
    "roomTemp": 23.5,
    "spCool": 23.5,
    "spHeat": 22,
    "spAuto": null,
    "humidity": 41.851562,
    "scheduleOwner": "adapter",
    "scheduleHoldEndTime": 0,
    "power": 1,
    "operationMode": "heat",
    "previousOperationMode": "heat",
    "connected": true,
    "hasSensor": true,
    "hasMhk2": false,
    "fanSpeed": "auto",
    "airDirection": "auto"
  }
}]
```

### Device Status

#### Get Device Status
```http
GET /v3/devices/{deviceSerial}/status
Authorization: Bearer {access_token}

Response:
{
  "id": "9c0deb2e-8427-4922-bf45-6847419b9327",
  "deviceSerial": "0Y34P008Q100172F",
  "rssi": -36,
  "power": 0,
  "operationMode": "off",
  "humidity": null,
  "fanSpeed": "auto",
  "airDirection": "auto",
  "roomTemp": 22,
  "spCool": 25,
  "spHeat": 23,
  "spAuto": null
}
```

### Send Commands

#### Control Device
```http
POST /v3/devices/send-command
Authorization: Bearer {access_token}
Content-Type: application/json

Request:
{
  "deviceSerial": "0Y34P008Q100142F",
  "commands": {
    "spHeat": 21.5,           // Heating setpoint in Celsius
    "spCool": 23.5,           // Cooling setpoint in Celsius
    "operationMode": "heat",  // "off", "heat", "cool", "auto"
    "fanSpeed": "auto"        // "auto", "low", "medium", "high"
  }
}

Response:
{
  "success": true
}
```

### Valid Command Values

**operationMode:**
- `"off"` - Unit off
- `"heat"` - Heating mode
- `"cool"` - Cooling mode
- `"auto"` - Auto mode

**fanSpeed:**
- `"auto"` - Automatic fan speed
- `"low"` - Low fan speed
- `"medium"` - Medium fan speed (assumed)
- `"high"` - High fan speed (assumed)

**Temperatures:**
- Celsius values (decimals allowed)
- `spHeat` - heating setpoint temperature
- `spCool` - cooling setpoint temperature

## Project Structure

```
homebridge-kumo-v3/
├── src/
│   ├── index.ts           // Plugin registration
│   ├── platform.ts        // Main platform class
│   ├── kumo-api.ts        // API client
│   ├── accessory.ts       // Thermostat accessory
│   └── settings.ts        // Constants and types
├── config.schema.json     // Homebridge config UI schema
├── package.json
├── tsconfig.json
└── README.md
```

## Implementation Requirements

### 1. KumoAPI Class (src/kumo-api.ts)

**Responsibilities:**
- Authenticate and manage tokens
- Auto-refresh access token before expiry (~20 min)
- Fetch sites
- Fetch zones for a site
- Get device status
- Send device commands

**Key Methods:**
```typescript
class KumoAPI {
  async login(username: string, password: string): Promise<boolean>
  async getSites(): Promise<Site[]>
  async getZones(siteId: string): Promise<Zone[]>
  async getDeviceStatus(deviceSerial: string): Promise<DeviceStatus>
  async sendCommand(deviceSerial: string, commands: Commands): Promise<boolean>
  private async refreshToken(): Promise<boolean>
}
```

**Token Management:**
- Store access token and refresh token
- Track token expiration time
- Auto-refresh 5 minutes before expiry
- Handle 401 errors by refreshing token

### 2. Platform Class (src/platform.ts)

**Responsibilities:**
- Read config (username, password)
- Initialize API client
- Discover devices on startup
- Create/register accessories
- Handle accessory restoration

**Discovery Flow:**
1. Login to API
2. Get all sites
3. For each site, get zones
4. Create thermostat accessory for each zone
5. Store accessories in Homebridge cache

### 3. Accessory Class (src/accessory.ts)

**Responsibilities:**
- Implement HomeKit Thermostat Service
- Poll device for status updates
- Handle characteristic get/set requests
- Map API values to HomeKit values

**HomeKit Characteristics to Implement:**

```typescript
// Required Characteristics
CurrentTemperature        // From roomTemp
TargetTemperature        // From spHeat or spCool based on mode
CurrentHeatingCoolingState  // From operationMode + power
TargetHeatingCoolingState   // From operationMode

// Optional Characteristics
TemperatureDisplayUnits  // Celsius/Fahrenheit
CurrentRelativeHumidity  // From humidity (if available)
```

**State Mapping:**

HomeKit → Kumo:
- OFF (0) → `{operationMode: "off"}`
- HEAT (1) → `{operationMode: "heat"}`
- COOL (2) → `{operationMode: "cool"}`
- AUTO (3) → `{operationMode: "auto"}`

Kumo → HomeKit:
- `operationMode: "off"` OR `power: 0` → OFF (0)
- `operationMode: "heat"` AND `power: 1` → HEAT (1)
- `operationMode: "cool"` AND `power: 1` → COOL (2)
- `operationMode: "auto"` AND `power: 1` → AUTO (3)

**Polling:**
- Update status every 30-60 seconds
- Don't poll more frequently than every 10 seconds
- Throttle requests to avoid rate limits

### 4. Settings (src/settings.ts)

**Constants:**
```typescript
export const PLATFORM_NAME = 'KumoV3';
export const PLUGIN_NAME = 'homebridge-kumo-v3';
export const API_BASE_URL = 'https://app-prod.kumocloud.com/v3';
export const TOKEN_REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes
export const POLL_INTERVAL = 30 * 1000; // 30 seconds
```

**Types:**
```typescript
export interface KumoConfig {
  platform: string;
  name?: string;
  username: string;
  password: string;
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
  fanSpeed: string;
  connected: boolean;
}

export interface Commands {
  spHeat?: number;
  spCool?: number;
  operationMode?: 'off' | 'heat' | 'cool' | 'auto';
  fanSpeed?: 'auto' | 'low' | 'medium' | 'high';
}
```

## Configuration

### config.json
```json
{
  "platforms": [
    {
      "platform": "KumoV3",
      "name": "Kumo",
      "username": "your-email@example.com",
      "password": "your-password"
    }
  ]
}
```

### config.schema.json
```json
{
  "pluginAlias": "KumoV3",
  "pluginType": "platform",
  "singular": true,
  "schema": {
    "type": "object",
    "properties": {
      "name": {
        "title": "Name",
        "type": "string",
        "default": "Kumo",
        "required": true
      },
      "username": {
        "title": "Username",
        "type": "string",
        "required": true,
        "description": "Your Kumo Cloud email address"
      },
      "password": {
        "title": "Password",
        "type": "string",
        "required": true,
        "description": "Your Kumo Cloud password"
      }
    }
  }
}
```

## Dependencies

### package.json
```json
{
  "name": "homebridge-kumo-v3",
  "version": "1.0.0",
  "description": "Homebridge plugin for Mitsubishi Kumo Cloud v3 API",
  "main": "dist/index.js",
  "scripts": {
    "build": "rimraf ./dist && tsc",
    "watch": "npm run build && npm link && nodemon",
    "prepublishOnly": "npm run build"
  },
  "keywords": [
    "homebridge-plugin",
    "mitsubishi",
    "kumo",
    "heat-pump"
  ],
  "engines": {
    "node": ">=14.18.1",
    "homebridge": ">=1.3.5"
  },
  "dependencies": {
    "node-fetch": "^3.2.0"
  },
  "devDependencies": {
    "@types/node": "^15.12.3",
    "homebridge": "^1.3.1",
    "nodemon": "^2.0.7",
    "rimraf": "^3.0.2",
    "typescript": "^4.2.2"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2018",
    "module": "commonjs",
    "lib": ["es2018"],
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "removeComments": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Reference Implementation

The old plugin can be referenced for:
- HomeKit characteristic mapping patterns
- Thermostat service setup
- Error handling and retry logic
- Polling and throttling strategies

Old plugin: https://github.com/fjs21/homebridge-kumo

**Key differences from old API:**
- Old: Array-based responses `data[0].token`, `data[2].children`
- New: Clean JSON objects with standard REST endpoints
- Old: Custom token encoding with crypto
- New: Standard JWT Bearer tokens
- Old: Single call returns everything
- New: Separate calls for sites → zones → status

## Testing Strategy

1. **Manual Testing:**
   - Install plugin in Homebridge
   - Verify devices appear in HomeKit
   - Test all modes (heat, cool, auto, off)
   - Test temperature changes
   - Test fan speed changes
   - Verify status updates

2. **Edge Cases:**
   - Token expiration and refresh
   - Network errors
   - Device offline
   - Multiple sites
   - Multiple zones per site

## Success Criteria

- ✅ Plugin authenticates with v3 API
- ✅ Discovers all zones/devices
- ✅ Creates HomeKit thermostat accessories
- ✅ Current temperature displays correctly
- ✅ Mode changes work (heat/cool/auto/off)
- ✅ Temperature setpoint changes work
- ✅ Status updates via polling
- ✅ Token auto-refresh works
- ✅ Handles errors gracefully

## Notes

- API uses Celsius - convert to Fahrenheit if user prefers
- Access token expires in ~20 minutes - implement refresh
- Don't poll faster than every 10 seconds per device
- Handle 401 errors by refreshing token
- Power=0 always means OFF regardless of operationMode
- Each zone has one adapter (heat pump unit)
