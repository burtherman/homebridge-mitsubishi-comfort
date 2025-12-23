# Claude.md - Project Documentation for AI Assistance

This document provides context about the homebridge-mitsubishi-comfort plugin architecture, implementation details, and recent changes to help Claude (or other AI assistants) understand the codebase.

## Project Overview

This is a Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API. It provides HomeKit integration for controlling Mitsubishi mini-split systems.

**Current Version:** 1.3.0

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

## Recent Major Changes

### v1.3.0 - Intelligent Streaming Health Monitoring and Adaptive Polling

**🎯 Goal:** Reduce API calls by 95% while maintaining reliability through smart fallback.

#### Key Achievement
- **Before:** ~257 API calls/hour (polling every 30s + streaming)
- **After:** ~12 API calls/hour (token refresh only when streaming healthy)
- **Reduction:** 95% fewer API calls and DNS queries

#### What Changed

**1. Streaming Health Monitoring (`kumo-api.ts`)**
- Added health tracking system that monitors Socket.IO connection status
- Health check every 30s (configurable)
- Callback system notifies platform of health changes
- Relies on Socket.IO's built-in heartbeat mechanism
- Code: `kumo-api.ts:36-42, 566-647`

**2. Adaptive Polling (`platform.ts`)**
- **Normal Mode:** Streaming healthy → polling disabled (if `disablePolling: true`)
- **Degraded Mode:** Streaming fails → fast polling activates (10s intervals)
- Automatic mode switching based on streaming health
- Comprehensive logging for all state transitions
- Code: `platform.ts:25-27, 343-458`

**3. Race Condition Prevention (`accessory.ts`)**
- Timestamp-based update filtering
- Prevents old polling data from overwriting newer streaming data
- Tracks update source (streaming vs polling)
- Code: `accessory.ts:15-16, 122-145`

**4. New Configuration Options**
- `disablePolling` - Now recommended! Enables optimal streaming-only mode
- `degradedPollInterval` - Fast polling when streaming unhealthy (default: 10s)
- `streamingHealthCheckInterval` - Health check frequency (default: 30s)
- `streamingStaleThreshold` - No longer used (deprecated, kept for compatibility)

#### How It Works

**Startup:**
```
1. Streaming connects → marked healthy
2. If disablePolling=true → no polling starts
3. Only token refresh queries (every 15 min)
```

**When Streaming Disconnects:**
```
1. Health check detects disconnect
2. Platform switches to DEGRADED MODE
3. Fast polling activates (10s intervals)
4. Devices remain responsive via polling
```

**When Streaming Reconnects:**
```
1. Socket reconnects → marked healthy
2. Platform switches to NORMAL MODE
3. Polling halts (if disablePolling=true)
4. Back to streaming-only updates
```

**Logging Examples:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mitsubishi Comfort Plugin Configuration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Streaming: ENABLED
Polling mode: On-demand only
Strategy: Streaming primary, polling fallback only
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Streaming connection established
Monitoring 3 device(s) for real-time updates

[When streaming fails]
✗ Streaming disconnected: transport close
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠ STREAMING INTERRUPTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
→ Switching to DEGRADED MODE
→ Polling activated: 10s intervals
```

### v1.2.0 - Real-time Streaming Support

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

#### Polling Strategy (Updated in v1.3.0)

**Current behavior:** Intelligent adaptive polling
- **With `disablePolling: true` (recommended):** Polling only activates when streaming fails
- **With `disablePolling: false` (default):** Polling runs continuously alongside streaming
- Interval: 30 seconds in normal mode (configurable via `pollInterval`)
- Degraded: 10 seconds when streaming fails (configurable via `degradedPollInterval`)
- Scope: Site-level (one API call per site fetches all zones)

**Why this approach:**
- Streaming is the primary update mechanism (instant, no API calls)
- Polling provides automatic fallback if streaming fails
- Health monitoring ensures seamless transitions
- 95% reduction in API calls when streaming is healthy

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
- `pollInterval` - Seconds between polls when streaming healthy (default: 30, min: 5)
- `disablePolling` - **Recommended!** Disable polling when streaming healthy (default: false)
- `degradedPollInterval` - Fast polling when streaming unhealthy (default: 10, min: 5, max: 60)
- `streamingHealthCheckInterval` - Health check frequency (default: 30, min: 10, max: 300)
- `streamingStaleThreshold` - Deprecated (no longer used, kept for compatibility)
- `excludeDevices` - Array of device serials to skip
- `debug` - Enable debug logging

**Recommended Configuration (Optimal Efficiency):**
```json
{
  "platform": "KumoV3",
  "username": "user@example.com",
  "password": "password123",
  "disablePolling": true
}
```

**Advanced Configuration:**
```json
{
  "platform": "KumoV3",
  "username": "user@example.com",
  "password": "password123",
  "disablePolling": true,
  "degradedPollInterval": 10,
  "streamingHealthCheckInterval": 30,
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

1. **Streaming initial messages:** When devices are first subscribed, we receive messages without full data (roomTemp undefined). Fixed in v1.3.0 - warnings suppressed during initial state.

2. **Mode switching:** AUTO mode uses `spAuto` setpoint, but some units don't support it (value is null). Fallback needed.

3. **Reconnection:** Socket.IO attempts to reconnect automatically, but max 5 attempts. After that, adaptive polling continues ensuring devices remain responsive.

4. **2FA Publishing:** npm publish requires passkey/OTP authentication. Use GitHub Actions workflow for automated publishing on release.

## Future Improvements

1. ~~**Conditional polling:** Only poll when streaming disconnected~~ ✅ **Implemented in v1.3.0**
2. **Better error handling:** More graceful degradation when API unavailable
3. **Humidity sensor:** Automatically add humidity sensor accessory when available
4. **Fan mode:** Support fan-only mode (currently mapped to COOL)
5. **Config UI:** Add streaming status indicator in Homebridge UI

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

- **1.3.0** - Intelligent streaming health monitoring and adaptive polling (95% API call reduction)
- **1.2.0** - Added Socket.IO streaming for real-time updates
- **1.1.0** - Centralized site-level polling, improved token management
- **1.0.0** - Initial release with Kumo Cloud v3 API support

## CI/CD

### GitHub Actions Workflow

Automated npm publishing on GitHub releases:
- File: `.github/workflows/publish.yml`
- Trigger: Publishing a GitHub release
- Authentication: npm Trusted Publishing (OIDC)
- No secrets required (uses OIDC tokens)
- Includes provenance for supply chain security

**To publish a new version:**
1. Update version in package.json: `npm version patch/minor/major`
2. Push with tags: `git push && git push --tags`
3. Create GitHub Release at target tag
4. GitHub Action automatically publishes to npm
