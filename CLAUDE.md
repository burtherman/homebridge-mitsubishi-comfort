# Claude.md - Project Documentation for AI Assistance

This document provides context about the homebridge-mitsubishi-comfort plugin architecture, implementation details, and recent changes to help Claude (or other AI assistants) understand the codebase.

## Project Overview

This is a Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API. It provides HomeKit integration for controlling Mitsubishi mini-split systems.

**Current Version:** 1.8.2

## Polling and Token Management

### Polling Strategy

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
- `localControl` - **Opt-in (default false).** Control units directly over the LAN; cloud stays for discovery/credentials and as a per-unit fallback. See "Local LAN Control". Requires a full homebridge restart to toggle (child bridge).
- `localPollInterval` - Seconds between local status polls when `localControl` is on (default: 15, min: 5, max: 120)
- `localControlIps` - Optional `{ "<deviceSerial>": "<ip>" }` map to skip LAN discovery for specific units
- `mirror` - **Opt-in device mirroring (since 1.8.0).** Array of `{ source, target }` device-serial pairs. Makes `target` follow `source`: whenever the source's commanded state changes (via any control path — wall thermostat, Kumo app, or HomeKit), the source's full state (mode, setpoints, on/off, fan) is copied to the target. One-way; a manual change to the target holds until the next source change re-syncs it. See "Device Mirroring".

## HomeKit Characteristics Mapping

| HomeKit Characteristic | Kumo API Field | Notes |
|----------------------|----------------|-------|
| CurrentTemperature | roomTemp | In Celsius |
| TargetTemperature | spHeat/spCool | Depends on mode. Dry → `spCool` (Kumo v3 keeps the dry setpoint there; no `spDry` field), gated on `usesSetPointInDryMode` |
| HeatingThresholdTemperature | spHeat | The low/heat edge of the AUTO band (since 1.6.0). Surfaced by the Home app only in AUTO |
| CoolingThresholdTemperature | spCool | The high/cool edge of the AUTO band (since 1.6.0). Surfaced by the Home app only in AUTO |
| CurrentHeatingCoolingState | power + operationMode | OFF/HEAT/COOL. Since 1.7.1 **dry and vent report COOL** (not OFF) so a running dehumidify/fan-only unit shows as on ("Cooling"), not a misleading "Off" |
| TargetHeatingCoolingState | operationMode | OFF/HEAT/COOL/AUTO. Since 1.7.1 **dry and vent map to COOL** so a scene/automation that sets the thermostat Off registers a real COOL→OFF transition iOS actually sends (it was suppressing the redundant Off→Off, so dry/vent units never turned off). Dry/vent are still *set* via their dedicated switches |
| CurrentRelativeHumidity | humidity | Optional sensor |
| FilterChangeIndication | displayConfig.filter | From streaming only |
| Model (AccessoryInformation) | modelNumber | Set once from streaming |
| Switch "Fan" (On) | operationMode === 'vent' && power === 1 | Separate `Switch` service; ON sends `vent`, OFF sends `off` (powers the unit down) |
| Switch "Dry" (On) | operationMode === 'dry' && power === 1 | Separate `Switch` service; ON sends `dry`, OFF sends `off`. Capability-gated on `hasModeDry`. Mutually exclusive with the Fan switch |

### Setpoint writes are held briefly (since 1.8.2)

Every setpoint write from HomeKit (`TargetTemperature` and both AUTO handles) is
held ~1.5s before it's sent (`accessory.ts:holdSetpointWrite`).

**Why:** an "AC off" scene re-pushes each thermostat's *captured* setpoints alongside
the off, and HomeKit dispatches them concurrently in arbitrary order. The 1.7.2
`offRequestedAt` guard only catches setpoints landing *after* the off — one landing
just *before* it arrives while the unit is still on, passes the guard, sends, and
permanently rewrites the device's stored setpoint. Observed live 2026-07-26: the scene
wrote the living room's stale captured `spCool` of 25°C while its mirror source (the
kitchen) sat at 22.5°C, and since mirroring is edge-triggered nothing re-synced them
for 36 minutes. The hold means an off arriving in the same burst cancels the pending
setpoint whichever order the two were dispatched in.

Writes are keyed per setpoint (`'target'` / `'spHeat'` / `'spCool'`, so the two AUTO
handles stay independent) with a generation counter — a superseded write is dropped
silently (it must *not* cache its stale value over the newer one), so a drag sends only
its final value. A write held across an off is cached + echoed, never sent, exactly
like the existing suppression path.

### AUTO dual setpoints

In AUTO, the Home app shows a temperature *range* (two handles) instead of a single setpoint, via the optional `HeatingThresholdTemperature` and `CoolingThresholdTemperature` characteristics on the Thermostat service.

- **Heating handle ↔ `spHeat`** (low/heat edge), **cooling handle ↔ `spCool`** (high/cool edge). These units report `spAuto: null` and `autoModeDisable: false`, so AUTO uses the `spHeat`/`spCool` band — live-verified (every poll showed `Auto: null` with independent setpoints).
- Both characteristics are added in the constructor (so they publish through the normal discovery path — no `publishStructureChange` needed) and their props are set to the device's supported range in `applyDeviceProfile`.
- **Writes are independent:** dragging the heating handle sends `{ spHeat }`, the cooling handle sends `{ spCool }` — neither clobbers the other edge. Both inherit the 1.5.2 powered-off guard (cache + echo, no `modeRequiredWhenDeviceOff` 400) and revert on failure.
- Zone/streaming updates sync both handles. The Home app only surfaces them in AUTO, so refreshing them in HEAT/COOL is harmless even when a unit's stale `spHeat`/`spCool` are inverted (each characteristic is independent within its own min/max props).
- `TargetTemperature` and the HEAT/COOL/DRY paths are untouched.
- Code: `accessory.ts:getHeatingThresholdTemperature / getCoolingThresholdTemperature / setThresholdTemperature`
- Live-verified end-to-end on real hardware (2026-06-14): both handles round-trip to `spHeat`/`spCool`, the cloud holds the band across a streaming reconcile.

### Fan-only switch

HomeKit's `Thermostat` service has no fan-only target state, so we expose a second `Switch` service per accessory (subtype `fan-only`).

- **Capability-gated:** the switch is only added once the device profile reports `hasModeVent === true`. If a cached accessory carries a switch but the profile reports no vent support, it's removed.
- **Switch ON** → `sendCommand({ operationMode: 'vent', power: 1 })`
- **Switch OFF** → `sendCommand({ operationMode: 'off', power: 0 })` — turns the unit off entirely
- The `power` field is sent explicitly on the fan path to match the verified v3 cloud reference ([EnumC/ha_kumo_ws](https://github.com/EnumC/ha_kumo_ws)); the existing HEAT/COOL/AUTO path still omits `power` since the API derives it from a non-off `operationMode`.
- The switch is kept in sync with streaming/polling updates: ON iff `power === 1 && operationMode === 'vent'`.
- Changing the thermostat to HEAT / COOL / AUTO / OFF optimistically flips the switch off. Engaging the switch optimistically drives the thermostat to its mapped state — since 1.7.1 vent maps to **COOL** (was OFF), so a scene-off registers a real transition (see the 1.7.1 note in Version History); the optimistic update derives both Current/Target from `mapTo*HeatingCoolingState`.
- Code: `accessory.ts:setupFanOnlySwitch / removeFanOnlySwitch / setFanOnlyOn / isFanOnlyActive`

### Dry switch

HomeKit's `Thermostat` service has no dehumidify target state either, so dry is surfaced the same way as fan-only: a separate `Switch` service per accessory (subtype `dry`).

- **Capability-gated:** added only once the device profile reports `hasModeDry === true` (a real top-level field in the v3 profile payload — see `API-EXPLORATION-FINDINGS.md`). A cached switch on a device that reports no dry support is removed.
- **Switch ON** → `sendCommand({ operationMode: 'dry', power: 1 })`
- **Switch OFF** → `sendCommand({ operationMode: 'off', power: 0 })` — turns the unit off entirely
- The switch is kept in sync with streaming/polling updates: ON iff `power === 1 && operationMode === 'dry'`.
- **Mutually exclusive with fan-only:** engaging dry optimistically flips the Fan switch off, and engaging fan-only flips the Dry switch off; changing the thermostat to HEAT / COOL / AUTO / OFF flips both off. Streaming/polling reconciles as the authoritative backstop. The optimistic cross-flip is unconditional because a successful command always leaves the unit in this switch's mode or `off` — never the sibling's mode.
- **Setpoint (since 1.5.3):** units that report `usesSetPointInDryMode === true` accept a target while dehumidifying, and the Kumo v3 cloud keeps that target in **`spCool`** (there is no `spDry` field). The on/off Dry *switch* can't express a temperature, but the **Thermostat's `TargetTemperature` characteristic** now reads/writes `spCool` while in dry (see `getTargetTempFromStatus` / `setTargetTemperature` / `dryUsesSetpoint`). Since 1.7.1 a dry unit reports `TargetHeatingCoolingState === COOL` (was OFF), so the stock Home app shows a Cool tile with a settable setpoint while dehumidifying. On units that report `usesSetPointInDryMode === false`, dry stays setpoint-less (the write falls through to the heat branch and the read falls back as before).
- Code: `accessory.ts:setupDrySwitch / removeDrySwitch / setDryOn / isDryActive`

## Local LAN Control (since 1.7.0, opt-in)

Direct control of the indoor units over the LAN, modeled on Home Assistant's
official `mitsubishi_comfort` integration (`iot_class: local_polling`). **Opt-in
via `localControl: true` (default off).** When off, behavior is unchanged (pure
cloud). When on, the plugin controls/reads each reachable unit directly and falls
back to the cloud per-unit; cloud streaming stays connected as the fallback.

**The local protocol** (`src/local-api.ts`) — a port of [pykumo](https://github.com/dlarrick/pykumo),
byte-for-byte identical to the `mitsubishi-comfort` library behind HA's integration,
and live-verified against real hardware:
- `PUT http://<ip>/api?m=<token>` (plain HTTP). Body `{"c":{"indoorUnit":{"status":{...}}}}`.
  A status read sends empty leaves; the unit echoes values back under `"r"`.
- `computeLocalToken()`: two SHA-256s over an 88-byte buffer (a fixed `W_PARAM`
  constant + `sha256(password ‖ body)` + `0x0840` + `S_PARAM=0` + a shuffled slice
  of the cryptoSerial).
- Local field names differ: `mode` (not `operationMode`), `vaneDir` (not
  `airDirection`). **No `power` field — `mode:"off"` is off.** `filterDirty` /
  `defrost` / `standby` are in the local status; **humidity is not** (it's a separate
  sensors/MHK2 query, sensor-equipped units only) so it stays cloud-sourced.
- `LocalKumoClient`: a per-device request mutex (the adapter tolerates ~one
  concurrent local connection — pykumo locks, the HA lib dropped it, we keep it) and
  a forgiving `Promise.race` timeout (node-fetch v3 dropped the `timeout` option).

**Credentials** (two per device, both already reachable from the cloud):
- `password` (base64) — arrives ONLY in the `adapter_update` Socket.IO event we
  already subscribe to (captured in `kumo-api.ts`, still stripped from logs).
- `cryptoSerial` (hex, 9 bytes) — `GET /devices/{serial}/status` (`getDeviceCryptoSerial`).

**Discovery** (`discoverDeviceIps`): the cloud provides neither IP nor MAC, so the
plugin sweeps the host's /24 and matches each device to the adapter that
authenticates its token (`r.indoorUnit` = match, `_api_error` = other Kumo unit).
~5–30s for a /24 (verified: found all 5 units). `localControlIps` config skips the
sweep for listed serials.

**Integration:**
- `platform.initLocalControl()` runs in the background after streaming connects:
  waits up to 25s for passwords, pairs with cryptoSerials, resolves IPs, starts local
  polling (`localPollInterval`, default 15s). `getHostIpv4()` derives the subnet
  (prefers private-LAN over CGNAT/VPN like Tailscale).
- **Credential retry (since 1.8.2):** adapters answer the `adapterStatus` nudge at
  wildly different speeds (measured across 5 units: 6s, 6s, 65s, never, never), so a
  fixed startup window strands healthy units on the cloud permanently. Any device
  still missing credentials is re-nudged every 60s (`scheduleLocalCredRetry` /
  `retryLocalCreds`) and admitted the moment they arrive; the LAN sweep runs only for
  devices that just yielded credentials. The retry stops when every device is local.
  A wedged adapter therefore rejoins local control on its own once it recovers.
- `accessory.sendDeviceCommand()`: local-first, cloud fallback (a failed/unreachable
  local send falls through to cloud).
- `accessory.updateFromLocal()`: feeds a local read into `processZoneUpdate` (source
  `'local'`), preserving streaming-sourced humidity.
- **Local-authoritative:** while a local poll arrived within 45s, cloud updates are
  dropped so the cloud's ~7–10s lag can't clobber fresher local data.
- Code: `src/local-api.ts`, `platform.ts:initLocalControl/gatherLocalCreds/admitLocalDevices/
  scheduleLocalCredRetry/retryLocalCreds/getHostIpv4/startLocalPolling`,
  `accessory.ts:sendDeviceCommand/updateFromLocal`, `kumo-api.ts:onAdapterPassword/getDeviceCryptoSerial`.

**Operational note:** child-bridge accessories get their config from the *parent*
homebridge process. Toggling `localControl` requires a **full homebridge restart**
(restart the main process), not just a child-bridge restart — the child reloads code
but not config.

## Device Mirroring (since 1.8.0, opt-in)

Makes one unit (target) follow another (source). **Opt-in via a `mirror` array
(default absent → the feature is entirely inert, no controller constructed).**

**Contract:**
- **One-way** source → target. Target changes never feed back.
- **Edge-triggered:** the target follows the source *only at the moment the source's
  commanded state changes*. Between source changes the target is free — a manual
  change to the target sticks until the next source change re-syncs it.
- **Full re-sync on any source change:** any source change re-applies the source's
  *full* state (mode + setpoint(s) + fan). So a source **temperature** change also
  re-syncs mode/power — a manually-off target is turned back on to match.
- **Source-agnostic:** triggers on the source's *observed actual state*, so a wall
  thermostat (MHK2) / IR remote, the Kumo app, and HomeKit all fire it. The plugin
  already watches the unit's real state via streaming + cloud-poll + local-poll; a
  HomeKit change to the source additionally fires immediately via the setter hook.

**Mechanism:**
- `src/mirror.ts` — `MirrorController`. Subscribes to each *source* accessory's
  `onStatusUpdate` hook. Keeps a **mode-aware signature** (only the mode-relevant
  setpoint(s) + fan, setpoints rounded to 0.1) so a drifting *inactive* setpoint
  (e.g. spCool while in heat, which the Home app doesn't even show) can't spuriously
  re-clobber a manually-adjusted target. First observation after (re)start **seeds the
  baseline without pushing** (a reboot isn't "someone changed the kitchen"). On a real
  change it debounces ~1s (collapses a mode+setpoint burst / fast drag into one push),
  then calls each target's `applyMirror`.
- `accessory.ts:onStatusUpdate / notifyStatusListeners` — fired at the end of
  `processZoneUpdate` (only on *applied* updates — dropped/stale updates never mirror)
  and from every setter's success path (so a HomeKit change to the source mirrors
  without waiting for the streaming/local echo; the controller's signature dedup makes
  the later echo a no-op).
- `accessory.ts:applyMirror` (target side) — normalizes mode (`autoHeat`/`autoCool` →
  `auto`), **clamps** setpoints to the target's own profile range, **capability-guards**
  (skips + logs if the target can't do the source's dry/vent mode), and sends **one
  combined atomic command** (`{ operationMode, spHeat?, spCool?, fanSpeedRaw? }`) via the
  normal local-first `sendDeviceCommand`. A single combined command means the 1.7.2
  trailing-setpoint race can't recur. Optimistic echo updates the target's tile; the
  next poll reconciles.
- **Fan speed** is mirrored via `Commands.fanSpeedRaw` — a verbatim adapter fan-speed
  string that bypasses the coarse `auto/low/medium/high` enum (which overlaps the local
  vocabulary with *different* meanings). Written verbatim on the local path
  (`local-api.ts:buildLocalCommandBody`); folded into `fanSpeed` on the cloud path
  (`kumo-api.ts:toCloudCommands`, best-effort).

**Latency:** a HomeKit change to the source mirrors in ~1s (debounce) via the setter
hook; a wall-thermostat / Kumo-app change mirrors when next *observed* — within one
local poll (~15s with `localControl` on) or a streaming / cloud-poll tick.

**Config:**
```json
"mirror": [
  { "source": "<sourceSerial>", "target": "<targetSerial>" }
]
```
One source may drive several targets (multiple entries). Unknown / self-referential
entries are warned and skipped at startup. Like `localControl`, `mirror` is read from
the *parent* Homebridge config, so toggling it needs a **full Homebridge restart**.

**Out of scope:** vane/louver direction, bidirectional sync, mirroring room temp /
humidity (sensor readings, not settings).

Code: `src/mirror.ts`, `accessory.ts:onStatusUpdate/applyMirror/clampSetpoint/normalizeMirrorMode`,
`platform.ts` (controller construction/teardown), `settings.ts` (`MirrorPair`/`MirrorState`/`Commands.fanSpeedRaw`),
`local-api.ts` + `kumo-api.ts` (fan passthrough), `config.schema.json`.
Spec: `docs/superpowers/specs/2026-07-22-device-mirroring-design.md`.

## Development Notes

### Testing Streaming

Test files in repo (not committed):
- `test-streaming.ts` - Basic Socket.IO connection test
- `test-streaming-v2.ts` - Full streaming test with subscriptions

### Deploying changes

```bash
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

## Version History

See `CHANGELOG.md`.

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

**Runner Node deprecation — resolved in 1.5.2 (2026-06-09):** `actions/checkout` and `actions/setup-node` are pinned to `@v5` (Node 24 runtime), ahead of GitHub's 2026-06-16 force-migration of `@v4` (Node 20) and the 2026-09-16 removal of Node 20 from runners. No further action needed; keep both at `@v5` (or newer) going forward.

**To publish a new version:**
1. Bump version: `npm version patch/minor/major --no-git-tag-version`, commit
2. Push to `main`
3. Create a GitHub Release at the `vX.Y.Z` tag — the Action publishes to npm automatically
