# Claude.md - Project Documentation for AI Assistance

This document provides context about the homebridge-mitsubishi-comfort plugin architecture, implementation details, and recent changes to help Claude (or other AI assistants) understand the codebase.

## Project Overview

This is a Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API. It provides HomeKit integration for controlling Mitsubishi mini-split systems.

**Current Version:** 1.2.0

## Architecture Overview

### Core Components

1. **platform.ts** - Main platform plugin
   - Handles device discovery and registration
   - Manages centralized site-level polling
   - Initializes streaming connection
   - Coordinates between accessories and API

2. **accessory.ts** - Individual thermostat accessory
   - Implements HomeKit thermostat service
   - Handles characteristic get/set operations
   - Receives updates from both streaming and polling
   - Manages device-specific state

3. **kumo-api.ts** - API client
   - Authentication with JWT tokens (auto-refresh every 15 minutes)
   - REST API endpoints for commands and device status
   - Socket.IO streaming for real-time updates
   - Connection management and error handling

4. **settings.ts** - Configuration and types
   - API endpoints and constants
   - TypeScript interfaces for all data structures
   - Configuration schema definitions

## Recent Major Changes (v1.2.0)

### Real-time Streaming Support

We added Socket.IO streaming to receive real-time device updates instead of relying solely on polling.

#### Implementation Details

**Streaming Connection:**
- Server: `socket-prod.kumocloud.com`
- Protocol: Socket.IO v4
- Transport: Polling initially, upgrades to WebSocket
- Authentication: Bearer token in extraHeaders

**Flow:**
1. Platform starts streaming after device discovery
2. Socket connects and emits 'subscribe' event for each device serial
3. Server sends 'device_update' events with full device state
4. Callbacks in accessory.ts process updates immediately
5. HomeKit characteristics update in real-time

**Key Code Locations:**
- Streaming initialization: `platform.ts:219-227`
- Socket.IO setup: `kumo-api.ts:418-497`
- Device subscription: `kumo-api.ts:499-507`
- Update handling: `accessory.ts:67-103`

#### Polling Redundancy

**Current behavior:** Polling runs continuously alongside streaming
- Reason: Provides redundancy and catches any missed streaming updates
- Interval: 30 seconds (configurable via `pollInterval`)
- Scope: Site-level (one API call per site fetches all zones)

**Why both run together:**
- Streaming might miss updates during reconnection
- Polling ensures we have full state even if streaming fails
- Simple, reliable approach without complex fallback logic

**Future consideration:** Could make polling a true fallback that only activates when streaming fails, but current approach prioritizes reliability over API call efficiency.

### Centralized Site Polling

Previously each accessory polled individually. Now polling happens at the platform level:
- One API call per site fetches all zones
- Platform distributes zone data to relevant accessories
- Significantly reduces API calls (5 devices → 1 API call per poll cycle)

**Code:** `platform.ts:242-288`

### Token Management

JWT tokens expire every 20 minutes. We handle this with:
- Auto-refresh at 15-minute mark (5 min before expiry)
- Concurrent request protection (multiple requests wait for single refresh)
- Automatic re-login if refresh fails
- Token included in both REST and Socket.IO auth

**Code:** `kumo-api.ts:119-209`

## API Details

### Kumo Cloud v3 API Endpoints

**Base URL:** `https://app-api.kumocloud.com/v3`

**Authentication:**
- `POST /login` - Returns access and refresh tokens
- `POST /refresh` - Refreshes access token

**Data Retrieval:**
- `GET /sites` - List all sites (homes)
- `GET /sites/{siteId}/zones` - Get all zones for a site
  - Returns full device status for each zone
  - This is the primary polling endpoint

**Commands:**
- `POST /devices/send-command` - Send command to device
  - Body: `{ deviceSerial: string, commands: Commands }`
  - Commands include: power, operationMode, spHeat, spCool, fanSpeed, etc.

### Socket.IO Streaming

**URL:** `wss://socket-prod.kumocloud.com`

**Events:**
- Client → Server: `'subscribe'` with deviceSerial
- Server → Client: `'device_update'` with full device state

**Device Update Format:**
```typescript
{
  id: string
  deviceSerial: string
  roomTemp: number
  spHeat: number
  spCool: number
  spAuto: number | null
  power: 0 | 1
  operationMode: 'off' | 'heat' | 'cool' | 'auto' | 'vent' | 'dry'
  fanSpeed: string
  airDirection: string
  humidity: number | null
  connected: boolean
  rssi: number
  // ... more fields
}
```

## Configuration

**Config Schema:** `config.schema.json`

**Required:**
- `username` - Kumo Cloud email (must include '@')
- `password` - Kumo Cloud password

**Optional:**
- `pollInterval` - Seconds between polls (default: 30, min: 5)
- `excludeDevices` - Array of device serials to skip
- `debug` - Enable debug logging

**Example:**
```json
{
  "platform": "KumoV3",
  "username": "user@example.com",
  "password": "password123",
  "pollInterval": 30,
  "excludeDevices": ["SERIAL123"],
  "debug": false
}
```

## HomeKit Characteristics Mapping

| HomeKit Characteristic | Kumo API Field | Notes |
|----------------------|----------------|-------|
| CurrentTemperature | roomTemp | In Celsius |
| TargetTemperature | spHeat/spCool | Depends on mode |
| CurrentHeatingCoolingState | power + operationMode | OFF/HEAT/COOL |
| TargetHeatingCoolingState | operationMode | OFF/HEAT/COOL/AUTO |
| CurrentRelativeHumidity | humidity | Optional sensor |

## Development Notes

### Testing Streaming

Test files in repo (not committed):
- `test-streaming.ts` - Basic Socket.IO connection test
- `test-streaming-v2.ts` - Full streaming test with subscriptions

### Building and Running

```bash
npm run build          # Compile TypeScript
npm run watch          # Watch mode for development
sudo systemctl restart homebridge  # Restart to test changes
```

### Debugging

Enable debug mode in config to see:
- API request/response details
- Streaming event logs
- Token refresh operations
- Device update processing

Logs location: `/var/lib/homebridge/homebridge.log`

## Known Issues and Limitations

1. **Streaming initial messages:** When devices are first subscribed, we receive messages without full data (roomTemp undefined). We filter these out in `accessory.ts:69-72`.

2. **Mode switching:** AUTO mode uses `spAuto` setpoint, but some units don't support it (value is null). Fallback needed.

3. **No streaming disable option:** Streaming is always enabled. Could add config option to disable if needed.

4. **Reconnection:** Socket.IO attempts to reconnect automatically, but max 5 attempts. After that, polling continues but streaming stops until Homebridge restart.

## Future Improvements

1. **Conditional polling:** Only poll when streaming disconnected
2. **Config option:** Allow disabling streaming
3. **Better error handling:** More graceful degradation when API unavailable
4. **Humidity sensor:** Automatically add humidity sensor accessory when available
5. **Fan mode:** Support fan-only mode (currently mapped to COOL)

## Important Files Reference

- **Entry point:** `src/index.ts` - Exports platform
- **Build output:** `dist/` - Compiled JavaScript
- **Type definitions:** `src/settings.ts` - All interfaces
- **Config schema:** `config.schema.json` - Homebridge UI schema

## Testing Checklist

When making changes, verify:
- [ ] Build succeeds without errors
- [ ] Homebridge starts without errors
- [ ] All devices discovered
- [ ] Streaming connects successfully
- [ ] Can control devices from HomeKit
- [ ] Temperature updates in real-time
- [ ] Mode changes work correctly
- [ ] Polling continues as backup

## Version History

- **1.2.0** - Added Socket.IO streaming for real-time updates
- **1.1.0** - Centralized site-level polling, improved token management
- **1.0.0** - Initial release with Kumo Cloud v3 API support
