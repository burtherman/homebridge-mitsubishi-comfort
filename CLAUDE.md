# Claude.md - Project Documentation for AI Assistance

This document provides context about the homebridge-mitsubishi-comfort plugin architecture, implementation details, and recent changes to help Claude (or other AI assistants) understand the codebase.

## Project Overview

This is a Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API. It provides HomeKit integration for controlling Mitsubishi mini-split systems.

**Current Version:** 1.5.2

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

**Base URL:** `https://app-prod.kumocloud.com/v3`

**Required Headers:**
- `Authorization: Bearer <access-token>` (all authenticated requests)
- `X-App-Version: 3.2.4` (all requests; constant in `settings.ts`)

**Authentication:**
- `POST /login` - Returns access and refresh tokens (plus user profile: id, email, etc.)
- `POST /refresh` - Refreshes access token

**Data Retrieval:**
- `GET /accounts/me` - Account info (similar to login response)
- `GET /sites` - List all sites (homes)
- `GET /sites/{siteId}/zones` - Get all zones for a site (includes nested `group` and `adapter` objects)
  - Returns full device status for each zone
  - This is the primary polling endpoint
- `GET /sites/{siteId}/groups` - System changeover groups (minRuntime, maxStandby)
- `GET /devices/{serial}` - Full device info (includes `model` object with brand, gallery image)
- `GET /devices/{serial}/profile` - Device capabilities (modes, fan speeds, setpoint limits)
- `GET /devices/{serial}/status` - Connection status, `cryptoSerial`, `firmwareVersion`, `autoModeDisable`
- `GET /devices/{serial}/kumo-properties` - Reporting, `outdoorAirTemperature`, `heatModeDisable`

**Commands:**
- `POST /devices/send-command` - Send command to device
  - Body: `{ deviceSerial: string, commands: Commands }`
  - Commands include: power, operationMode, spHeat, spCool, fanSpeed, etc.

### Socket.IO Streaming

**URL:** `wss://socket-prod.kumocloud.com`

**Client → Server Emits:**
| Emit | Arguments | Description |
|------|-----------|-------------|
| `subscribe` | `(deviceSerial)` | Subscribe to device updates |
| `subscribe` | `('', userId)` | Account-level subscribe (needed for `adapter_update`) |
| `force_adapter_request` | `(deviceSerial, 'iuStatus')` | Request indoor unit status |
| `force_adapter_request` | `(deviceSerial, 'profile')` | Request device profile → triggers `profile_update` |
| `force_adapter_request` | `(deviceSerial, 'adapterStatus')` | Request adapter info → triggers `adapter_update` |
| `device_status_v2` | `(deviceSerial)` or `('')` | Request connection status |

**Server → Client Events:**
| Event | Description |
|-------|-------------|
| `device_update` | Full device state (temperature, mode, setpoints, displayConfig) |
| `profile_update` | Device capabilities (modes, fan speeds, setpoint limits) |
| `device_status_v2` | Connection status (connected/disconnected) |
| `adapter_update` | Adapter hardware (firmware, WiFi RSSI — contains password, strip before logging) |
| `acoil_update` | A-coil/outdoor unit data (minimal: serial + date) |

**`device_update` Format:**
```typescript
{
  id: string
  deviceSerial: string
  roomTemp: number
  spHeat: number
  spCool: number
  spAuto: number | null
  power: 0 | 1
  operationMode: 'off' | 'heat' | 'cool' | 'auto' | 'autoHeat' | 'autoCool' | 'vent' | 'dry'
  fanSpeed: string
  airDirection: string
  humidity: number | null
  connected: boolean
  rssi: number
  modelNumber: string                  // e.g. "SVZ-KP30NA"
  previousOperationMode: string
  displayConfig: {
    filter: boolean                    // filter needs cleaning (= filterDirty in local API)
    defrost: boolean                   // defrost cycle active
    standby: boolean                   // compressor idle
    hotAdjust: boolean
  }
  // Also includes: isSimulator, ledDisabled, isHeadless, scheduleOwner,
  // scheduleHoldEndTime, activeThermistor, tempSource, twoFiguresCode,
  // unusualFigures, statusDisplay, runTest, lastStatusChangeAt, createdAt, updatedAt, timeZone
}
```

**Note on `operationMode`:** When *sending* commands, use `'auto'`. The API *returns* `'autoHeat'` or `'autoCool'` to indicate which sub-mode auto is currently in. The code handles this via `startsWith('auto')` in `accessory.ts`.

**Note on `autoModeDisable`:** The `/devices/{serial}/status` endpoint returns `autoModeDisable: true` for units that don't support auto mode at the hardware level. This explains why `spAuto` is null for some devices.

**Field documentation sourced from:** [dlarrick/hass-kumo](https://github.com/dlarrick/hass-kumo),
[EnumC/ha_kumo_ws](https://github.com/EnumC/ha_kumo_ws), and
[dlarrick/pykumo](https://github.com/dlarrick/pykumo) (`Cloud_api_v3.md`).
See `API-EXPLORATION-FINDINGS.md` for full field reference including `profile_update` and `adapter_update` payloads.

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
| FilterChangeIndication | displayConfig.filter | From streaming only |
| Model (AccessoryInformation) | modelNumber | Set once from streaming |
| Switch "Fan" (On) | operationMode === 'vent' && power === 1 | Separate `Switch` service; ON sends `vent`, OFF sends `off` (powers the unit down) |
| Switch "Dry" (On) | operationMode === 'dry' && power === 1 | Separate `Switch` service; ON sends `dry`, OFF sends `off`. Capability-gated on `hasModeDry`. Mutually exclusive with the Fan switch |

### Fan-only switch

HomeKit's `Thermostat` service has no fan-only target state, so we expose a second `Switch` service per accessory (subtype `fan-only`).

- **Capability-gated:** the switch is only added once the device profile reports `hasModeVent === true`. If a cached accessory carries a switch but the profile reports no vent support, it's removed.
- **Switch ON** → `sendCommand({ operationMode: 'vent', power: 1 })`
- **Switch OFF** → `sendCommand({ operationMode: 'off', power: 0 })` — turns the unit off entirely
- The `power` field is sent explicitly on the fan path to match the verified v3 cloud reference ([EnumC/ha_kumo_ws](https://github.com/EnumC/ha_kumo_ws)); the existing HEAT/COOL/AUTO path still omits `power` since the API derives it from a non-off `operationMode`.
- The switch is kept in sync with streaming/polling updates: ON iff `power === 1 && operationMode === 'vent'`.
- Changing the thermostat to HEAT / COOL / AUTO / OFF optimistically flips the switch off; engaging the switch optimistically sets the thermostat to OFF (since HomeKit's thermostat service can't represent fan-only).
- Code: `accessory.ts:setupFanOnlySwitch / removeFanOnlySwitch / setFanOnlyOn / isFanOnlyActive`

### Dry switch

HomeKit's `Thermostat` service has no dehumidify target state either, so dry is surfaced the same way as fan-only: a separate `Switch` service per accessory (subtype `dry`).

- **Capability-gated:** added only once the device profile reports `hasModeDry === true` (a real top-level field in the v3 profile payload — see `API-EXPLORATION-FINDINGS.md`). A cached switch on a device that reports no dry support is removed.
- **Switch ON** → `sendCommand({ operationMode: 'dry', power: 1 })`
- **Switch OFF** → `sendCommand({ operationMode: 'off', power: 0 })` — turns the unit off entirely
- The switch is kept in sync with streaming/polling updates: ON iff `power === 1 && operationMode === 'dry'`.
- **Mutually exclusive with fan-only:** engaging dry optimistically flips the Fan switch off, and engaging fan-only flips the Dry switch off; changing the thermostat to HEAT / COOL / AUTO / OFF flips both off. Streaming/polling reconciles as the authoritative backstop. The optimistic cross-flip is unconditional because a successful command always leaves the unit in this switch's mode or `off` — never the sibling's mode.
- **Setpoint limitation:** some units report `usesSetPointInDryMode === true`, meaning they accept a target while dehumidifying. An on/off switch can't express that, so dry runs at the unit's default setpoint (same inherent HomeKit constraint as fan having no speed). While dry is active the thermostat tile shows OFF.
- Code: `accessory.ts:setupDrySwitch / removeDrySwitch / setDryOn / isDryActive`

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
4. ~~**Fan mode:** Support fan-only mode~~ ✅ Exposed as a separate `Switch` service per accessory
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

- **1.5.2** - Don't send a setpoint to a powered-off unit (June 2026)
  - Fixed: setting a TargetTemperature while a unit is off sent a bare `{ spHeat }` with no `operationMode`, which the Kumo v3 API rejects with `modeRequiredWhenDeviceOff` (HTTP 400). Every such attempt logged a cluster of red errors (`Request failed with status: 400` → `Send command failed` → `Failed to set target temperature`)
  - Real-world trigger: a HomeKit automation/scene that turns the AC off (e.g. "off when the skylight opens") captures each thermostat's *full* state, so firing it re-pushes the last setpoint alongside `off`. The `off` succeeded; the trailing setpoint on the now-off unit produced the 400s. The "all units, same second, `HomeKit sent`" log signature distinguishes a controller-pushed burst from a user tap
  - Fix: `setTargetTemperature` now short-circuits when `power === 0 || operationMode === 'off'` — it caches the value and echoes it to HomeKit (so the slider holds) without sending a doomed command. Heat/cool/auto paths unchanged
  - `node:test` regression (`test/setpoint-while-off.test.js`): off → no command sent (failed pre-fix with `1 !== 0`), off → value still echoed, heat → setpoint still sent (control)
  - Code: `accessory.ts:setTargetTemperature`
- **1.5.1** - Publish runtime-added features to HomeKit (June 2026)
  - Fixed: the fan-only switch (since 1.4.0), the dry switch (1.5.0), the humidity characteristic, and the filter indicator were all added to the accessory *after* it was published to the bridge (from async `profile_update` / first-reading callbacks) but never re-published — so they existed in memory and the HAP cache but never reached the Home app
  - Root cause: no `api.updatePlatformAccessories([accessory])` call after a runtime structural change. Centralized in `accessory.ts:publishStructureChange()`, called at every add/remove site (switches, humidity, filter)
  - `node:test` coverage extended (`test/switch-publish.test.js`) — asserts a re-publish happens on switch add/remove and on the first humidity reading; proven to fail against the pre-fix build
  - **Operational caveat:** publishing the service is necessary but not always sufficient. HomeKit controllers cache an accessory's *service list* and only re-read it when the bridge's configuration number (`c#`) increases. iOS will not surface services added to an already-paired accessory until its cache is cleared — a full **device reboot** (clears the `homed` cache) or removing/re-adding the child bridge. Force-quitting the Home app or restarting a Home hub is not enough.
  - Child bridge accessories persist to `accessories/cachedAccessories.<username-without-colons>` (e.g. `cachedAccessories.0EA3CB05C3A2`), NOT the main `cachedAccessories`
  - Code: `accessory.ts:publishStructureChange and its 6 call sites`
- **1.5.0** - Dry (dehumidify) mode as a Switch (June 2026)
  - Exposes dry mode as a separate `Switch` service per thermostat (subtype `dry`), mirroring the fan-only switch (#14)
  - Capability-gated on `profile.hasModeDry`; a cached switch is removed if the device reports no dry support
  - Switch ON → `sendCommand({ operationMode: 'dry', power: 1 })`; OFF → `{ operationMode: 'off', power: 0 }`
  - Fan-only and dry are mutually exclusive: engaging one optimistically flips the other off, with streaming/polling as the backstop
  - HomeKit's Thermostat service has no dehumidify state, so (like fan-only) the thermostat shows OFF while dry is active; the unit's dry setpoint (`usesSetPointInDryMode`) can't be exposed through an on/off switch
  - Code: `accessory.ts:setupDrySwitch / removeDrySwitch / setDryOn / isDryActive`
- **1.4.1** - Self-healing device discovery (May 2026)
  - Fixed: a transient login/network failure at startup (e.g. a DNS blip) left the plugin idle until a manual restart — `discoverDevices()` logged the error and returned with no retry, so streaming never started
  - `discoverDevices()` now retries with exponential backoff (30s → 5min cap) and keeps retrying indefinitely, recovering on its own once connectivity returns
  - Retry is idempotent: an `accessoryHandlers` guard prevents double-registering devices across attempts
  - A transient empty zones response no longer unregisters every cached accessory as "stale" — it retries instead
  - Added `node:test` regression tests (`test/discovery-retry.test.js`, run via `npm test`)
  - Code: `platform.ts:34-38, 107-112, 136-176`
- **1.4.0** - Humidity stabilization, fan-only mode, v3 API docs (May 2026)
  - Fan-only mode exposed as a separate `Switch` service per thermostat (#11)
  - Stabilized humidity characteristic and documented v3 API endpoints (#13)
  - Added debug logging to the token refresh flow (#12)
- **1.3.6** - Streaming events, device profiles, filter maintenance, model number (March 2026)
  - Listen for `profile_update`, `device_status_v2`, `adapter_update`, `acoil_update` streaming events
  - Account-level Socket.IO subscription + `force_adapter_request` emits to trigger profile/status data
  - JWT user ID extraction for account-level subscribe (required for adapter_update events)
  - `DeviceProfile` interface stores per-device capabilities (modes, fan speeds, vane, setpoint limits)
  - HomeKit TargetTemperature now enforces correct min/max from device profile (e.g., 17-30°C)
  - Devices report "Not Responding" in HomeKit when `device_status_v2` reports disconnected
  - Adapter firmware version and WiFi RSSI logged (password stripped from logs)
  - HomeKit FilterMaintenance service shows filter dirty status from `displayConfig.filter`
  - Model number extracted from streaming `device_update` and set on AccessoryInformation
  - Extended `DeviceStatus` with `modelNumber`, `connected`, `standby`, `defrost`, `filterDirty`
  - Cleaned up verbose raw JSON logging (debug-level only)
  - Streaming field documentation sourced from [hass-kumo](https://github.com/dlarrick/hass-kumo) / [ha_kumo_ws](https://github.com/EnumC/ha_kumo_ws) / [pykumo](https://github.com/dlarrick/pykumo)
  - Code: `kumo-api.ts:34-39, 616-742`, `accessory.ts:21-22, 123-200`, `settings.ts:7, 81-86`
- **1.3.5** - Token refresh jitter to prevent rate limits (January 2026)
  - Added random 0-60 second jitter to token refresh timing
  - Prevents predictable API calls that trigger 429 rate limit errors
  - Code: `kumo-api.ts:188-202`
- **1.3.4** - Silent routine reconnect logging (January 2026)
  - Routine token refresh reconnections now debug-level only
  - Initial connections and actual errors remain at info level
  - Cleaner logs when streaming is working normally
- **1.3.3** - Streaming architecture improvements (January 2026)
  - Socket reconnect after every token refresh (ensures fresh token is used)
  - Added 10-second hysteresis before exiting degraded mode
  - Added 20-second socket connection timeout
  - Removed unused vestigial code (reconnectAttempts, lastStreamingUpdate)
  - Added device serial validation before subscribe
  - Suppresses spurious "STREAMING INTERRUPTED" during planned reconnects
  - Code: `kumo-api.ts:39-40, 796-827`, `platform.ts:25-27, 343-458`
- **1.3.2** - Rate limit handling with exponential backoff (January 2025)
  - Added intelligent rate limit detection for 429 errors
  - Implemented exponential backoff for token refresh (5s → 60s max)
  - Implemented exponential backoff for login (5s → 120s max)
  - Enforced minimum 10-second interval between login attempts
  - Prevents cascading rate limit violations
  - Code: `kumo-api.ts:44-50`, `kumo-api.ts:82-178`, `kumo-api.ts:146-238`
- **1.3.1** - Enhanced logging and API exploration (December 2025)
  - Added always-on logging for mode changes (`[MODE CHANGE]` prefix)
  - Enhanced temperature change logging with Fahrenheit conversion
  - Improved error logging for API validation failures (always log 400 errors)
  - Discovered new API endpoints: `/config` and `/devices/{serial}/profile`
  - Documented temperature limit constraints (see `API-EXPLORATION-FINDINGS.md`)
  - Code: `kumo-api.ts:284-291`, `accessory.ts:326-372`
- **1.3.0** - Intelligent streaming health monitoring and adaptive polling (95% API call reduction)
- **1.2.0** - Added Socket.IO streaming for real-time updates
- **1.1.0** - Centralized site-level polling, improved token management
- **1.0.0** - Initial release with Kumo Cloud v3 API support

## CI/CD

### GitHub Actions Workflow

Automated npm publishing on GitHub releases:
- File: `.github/workflows/publish.yml`
- Trigger: publishing a GitHub release (or manual `workflow_dispatch` for testing)
- Authentication: npm Trusted Publishing (OIDC) — no `NPM_TOKEN` secret required
- Includes provenance for supply chain security

**OIDC requirements (don't break these):**
- Workflow needs `permissions: id-token: write`
- Runner needs npm CLI >= 11.5.1 (the `Upgrade npm for trusted publishing` step installs `npm@latest`)
- Do NOT add `registry-url`/`NODE_AUTH_TOKEN` to `setup-node` — they make npm expect a token and break OIDC (this caused E404-on-PUT auth failures through v1.4.1, which were worked around by manual `npm publish`)
- A Trusted Publisher must be configured for the package on npmjs.com (package → Settings/Access): GitHub org/user `burtherman`, repo `homebridge-mitsubishi-comfort`, workflow `publish.yml`, environment blank
- `package.json` `repository.url` must match the trusted-publisher repo

**Pending maintenance — runner Node deprecation (flagged June 2026):** the publish run warns that `actions/checkout@v4` and `actions/setup-node@v4` run on Node 20, which GitHub force-migrates to Node 24 on **2026-06-16** (Node 20 removed from runners 2026-09-16). The `@v4` actions are expected to keep working, but bump both to `@v5` in `publish.yml` to remove the risk to the publish pipeline.

**To publish a new version:**
1. Bump version: `npm version patch/minor/major --no-git-tag-version`, commit
2. Push to `main`
3. Create a GitHub Release at the `vX.Y.Z` tag — the Action publishes to npm automatically
