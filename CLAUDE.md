# Claude.md - Project Documentation for AI Assistance

This document provides context about the homebridge-mitsubishi-comfort plugin architecture, implementation details, and recent changes to help Claude (or other AI assistants) understand the codebase.

## Project Overview

This is a Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API. It provides HomeKit integration for controlling Mitsubishi mini-split systems.

**Current Version:** 2.0.0 (unreleased; 1.10.4 is the latest published)

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
- `GET /devices/{serial}/status` - `firmwareVersion`, `routerSsid`, `routerRssi`, `lastUpdated`, `mac`, `minSetPoint`/`maxSetPoint`, `roomTempDisplayOffset`
  - **No longer returns `cryptoSerial`** (Mitsubishi removed it ~2026-08-01). It also no
    longer returns `autoModeDisable`. See `docs/LOCAL-CREDENTIAL-SOURCES.md`.
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
- `showDrySwitch` / `showFanOnlySwitch` - (2.0) Show the Dry / Fan switches on capable units (default **true**, opt-out). "Shown", not "on": each switch's state follows the unit's real mode. The fork hid them by default; ours stay shown because they're the only HomeKit controls whose automations survive the Thermostat → HeaterCooler move.
- `showHumiditySensor` - (2.0) Humidity as a `HumiditySensor` service (default true). Off also removes a cached one.

## HomeKit Characteristics Mapping (2.0: HeaterCooler)

Each unit is a `HeaterCooler` (was `Thermostat` through 1.x). Ported from the fork
`homebridge-mitsubishi-heatpump` (ukaratay, Apache-2.0) with attribution — see NOTICE and
`docs/superpowers/specs/2026-09-27-heatercooler-port-plan.md` (stage 7 still to do:
schema, release).

| HomeKit Characteristic | Kumo API Field | Notes |
|----------------------|----------------|-------|
| Active | power + operationMode | ACTIVE iff `power === 1 && mode !== 'off'`. Power is separate from mode, so an off scene is always a real 1→0 — including dry/vent, which retires the 1.7.1 workaround |
| CurrentHeaterCoolerState | power + mode + standby | INACTIVE (off), IDLE (standby, or vent), HEATING (heat/autoHeat), COOLING (cool/autoCool/dry). Plain `auto` infers from the band |
| TargetHeaterCoolerState | operationMode | AUTO/HEAT/COOL only (no OFF: that's Active). dry/vent → COOL. **While off, shows the remembered power-on mode.** `validValues` limited by `hasModeHeat` |
| CurrentTemperature | roomTemp | In Celsius |
| HeatingThresholdTemperature | spHeat | THE heat setpoint in every mode (HEAT shows it; AUTO shows it as the low edge). Range = heat ∪ auto from the profile |
| CoolingThresholdTemperature | spCool | THE cool setpoint in every mode, and the dry setpoint. Range = cool ∪ auto |
| Fanv2 (subtype `airflow`).RotationSpeed | fanSpeed | 5 detents 0/25/50/75/100 = superQuiet/quiet/low/powerful/superPowerful. Never 'auto' |
| Fanv2.TargetFanState | fanSpeed === 'auto' | AUTO/MANUAL; registered only if the profile has `hasFanSpeedAuto`. MANUAL restores `lastManualFan` |
| Fanv2.Active / CurrentFanState | power/mode/standby | Follows the unit. **Fan-tile OFF is refused** (a room-wide "turn off the fan" must not stop the heat pump); ON = setActive(1) |
| HeaterCooler.SwingMode | airDirection === 'swing' | Registered only if `hasVaneSwing`. OFF restores `lastFixedVane` ('auto' if none seen) |
| Slats.TargetTiltAngle / CurrentTiltAngle / CurrentSlatState | airDirection | Opt-in `exposeVaneSlat` + `hasVaneDir`. -90/-45/0/45/90 = horizontal/midhorizontal/midpoint/midvertical/vertical; nearest wins |
| HumiditySensor.CurrentRelativeHumidity | humidity | Separate service (HeaterCooler has no humidity characteristic), linked to the HeaterCooler. Created on the first reading; removed only when the cloud's zone record says `hasSensor: false`, `hasMhk2` not true and `humidity: null` (`applyZoneSensors`, at startup and on fallback polls). A missing reading alone never removes it |
| FilterMaintenance.FilterChangeIndication | displayConfig.filter | Linked to the HeaterCooler |
| Model (AccessoryInformation) | modelNumber | Set once from streaming |
| Switch "Fan Only" (On) | operationMode === 'vent' && power === 1 | Separate `Switch` (subtype `fan-only`); ON sends `vent`, OFF sends `off`. Named "Fan" in 1.x; renamed only if it still has the old default ConfiguredName |
| Switch "Dry" (On) | operationMode === 'dry' && power === 1 | Separate `Switch` (subtype `dry`); ON sends `dry`, OFF sends `off`. Mutually exclusive with Fan |

There is **no TargetTemperature**. Removing that second writer is what stops a scene's
captured target from collapsing the AUTO band.

**Migration:** the constructor removes a cached `Thermostat` service and logs
`migrated Thermostat -> HeaterCooler`. Accessory UUIDs come from the serial, so name and
room survive; automations bound to the thermostat must be recreated. Switch subtypes are
unchanged, so switch automations survive. Owner's install: one automation (skylight opens →
all units off) — rebuild it right after upgrading and verify from the log.

**Home app tile (observed 2026-09-27, owner's iPhone):**
- Every upgraded unit's *combined* tile drew as a switch ("All Off"), even at the large size.
  "Show as Separate Tiles" draws the heater-cooler correctly, so the services are fine.
- Primary + linked services do NOT control the combined tile's look. Linking the switches
  (`004a583`) didn't change it. The fork found the same with its humidity sensor
  (fork commit 6caceef).
- `moveTileServiceFirst` (`a7f6aa2`) lists the HeaterCooler first, the way 1.x's Thermostat
  was. That didn't change the combined tile either (owner checked after the deploy). So
  it's neither primary, links nor order; what iOS keys the combined tile on is unknown.
- **No fan Auto control** appeared, though `TargetFanState` is published on every unit. The
  fork's research says the Home app shows it as Manual | Auto. The Home app sent
  `TargetFanState` AUTO with two mode changes (21:38:24 and 21:38:30), so a mode change
  may reset the fan to auto. Unconfirmed.
- The fork tried fan auto as the slider's 0% first and dropped it (fork commit db4d2bb):
  0% reads as off, and in auto the unit may blow hard while the slider shows the slowest.
- Kitchen fan: 100% (superPowerful) was sent and a local poll ~14s later reported
  `powerful`. The units' profiles say 3 speeds, and the fork's claim that 3-speed units
  accept all five doesn't hold here. The per-unit speed test is still pending.

### Power and mode (2.0)

- **Power-on restores the last active mode.** HomeKit sends Active=1 with no mode, and an
  off unit reports `'off'`. The fork fell back to AUTO (its `previousOperationMode` was
  overwritten with the current mode). We keep `accessory.context.lastActiveMode` (persisted by
  Homebridge), updated from every applied active status, seeded from the cloud's real
  `previousOperationMode` when empty. No history at all → AUTO (COOL on a cooling-only unit).
- **One burst, one command** (`queuePowerMode` / `flushPowerMode`). hap-nodejs dispatches every
  handler in a write request concurrently without awaiting, so Active and
  TargetHeaterCoolerState from one scene arrive in any order. A zero-delay timer coalesces
  them: Active=0 wins (an off scene's captured mode rides along); Active=1 uses the burst's mode
  or the remembered one; a mode alone turns the unit on in that mode unless an off is in
  flight (`offInFlight`).
- **Same-burst setpoints join the power-on.** A threshold written while the unit is off is
  cached (can't be sent: `modeRequiredWhenDeviceOff`), and recorded in
  `setpointsCachedWhileOff` unless an off is in flight. A power-on flushed within
  `SAME_BURST_MS` (1s) includes it, so "on, cool, 72" is one command at 72. Older cached values
  are never applied — an "AC off" scene re-sends stale setpoints, and applying those later is
  the 1.8.2 bug. (The 1.x Thermostat had the same "setpoint lost at power-on" gap.)
- Setpoints are snapped to the whole-°F grid in the setters (`quantize` →
  `temperature.ts:quantizeSetpointInRange`): 72°F → 22.3°C.
- `setThresholdRange` moves a characteristic's value into a new range before `setProps`, or
  HAP warns (it starts the heating threshold at 0).
- Checked against real hap-nodejs services inside a Homebridge `PlatformAccessory`
  (2026-09-27): no characteristic warnings from the HeaterCooler. The one remaining warning
  is pre-existing: `ConfiguredName` on the Switch services.

### Fan speed (2.0 stage 5)

- Fanv2 service (subtype `airflow`), linked to the HeaterCooler (which is primary). Ported
  from the fork's final design (`setupFanService`, `fanSpeedToRotation`, `rotationToFanSpeed`,
  `syncFanCharacteristics`, fan-tile OFF refusal).
- **Fan writes share the power/mode queue** (`queueIntent` → `flushIntent` → `flushFanOnly`).
  Explicit AUTO beats a slider speed in the same burst. With a power-on or mode change the fan
  speed rides in the same command; with Active=0 it's dropped (an off scene's captured fan
  speed would otherwise rewrite the unit's stored speed, the 1.8.2 class of bug).
- **Deliberate deviation from the fork:** a fan change on its own is NOT sent to an off unit
  (or one being turned off). The fork sends it, citing its own live test that a fan write left
  an off unit off. Our 1.7.2 notes record a bare, mode-less LOCAL write reviving an off unit,
  and a fan write has no mode either. Not verified on our hardware — revisit after checking a
  fan-only write to an off unit over the LAN (then this can match the fork).
- All five speeds are offered regardless of the profile's `numberOfFanSpeeds` (3 on our units).
  The fork found it advisory on its units; the Pi checklist verifies each speed on each unit.
- Origin label `homekit:fan`; every successful fan write notifies the mirror (fan speed is in
  its signature).

### Vanes (2.0 stage 6)

- SwingMode on the HeaterCooler (not the fan: the Home app doesn't show a linked fan's
  oscillate toggle on a combined tile — the fork's research). Slats service opt-in via
  `exposeVaneSlat` (Apple Home files Slats under window coverings). Ported from the fork.
- Vane writes share the power/mode/fan queue with the same rules as fan speed (dropped
  with an off, ride along with a power-on, not sent alone to an off unit —
  `flushAirflowOnly`). Origin `homekit:vane`.
- Owner's units have fixed vanes (`hasVaneDir`/`hasVaneSwing` false), so none of this
  appears on them. Coverage is unit tests + a volunteer with movable vanes (issue #6).
- **Mirror:** `MirrorState.airDirection` and the signature (`…|fan|v:<vane>`) include the
  vane; `applyMirror` sends `vaneDir` only to a target whose profile has the capability
  (`mirrorVane`: swing needs hasVaneSwing, other positions hasVaneDir, nothing before the
  profile arrives). Changing the signature format is why `mirror-store.ts` is now
  **version 2** and discards other versions on load: an old-format signature can never match,
  so the first restart after upgrading would otherwise read as "source changed while down"
  and push the kitchen onto the living room. That one restart degrades to seed-only.

### Setpoint writes are held briefly (since 1.8.2)

Every threshold write from HomeKit is held ~1.5s before it's sent
(`accessory.ts:holdSetpointWrite`).

**Why:** an "AC off" scene re-pushes each unit's *captured* setpoints alongside
the off, and HomeKit dispatches them concurrently in arbitrary order. The 1.7.2
`offRequestedAt` guard only catches setpoints landing *after* the off — one landing
just *before* it arrives while the unit is still on, passes the guard, sends, and
permanently rewrites the device's stored setpoint. Observed live 2026-07-26: the scene
wrote the living room's stale captured `spCool` of 25°C while its mirror source (the
kitchen) sat at 22.5°C, and since mirroring is edge-triggered nothing re-synced them
for 36 minutes. The hold means an off arriving in the same burst cancels the pending
setpoint whichever order the two were dispatched in.

Writes are keyed per setpoint (`'spHeat'` / `'spCool'`, independent) with a generation
counter — a superseded write is dropped silently (it must *not* cache its stale value over
the newer one), so a drag sends only its final value. A write held across an off is cached +
echoed, never sent, exactly like the existing suppression path. (1.x also had a `'target'` key
for TargetTemperature; gone in 2.0.)

### Setpoints (HEAT, COOL, AUTO band)

- **Heating threshold ↔ `spHeat`**, **cooling threshold ↔ `spCool`**, in every mode. These units
  report `spAuto: null` and `autoModeDisable: false`, so AUTO uses the `spHeat`/`spCool` band —
  live-verified (1.6.0, 2026-06-14: both handles round-trip, the cloud holds the band).
- Each gets its own mode's range widened to auto (`setpointRanges`). 1.x gave both the union of
  all modes, so COOL offered HEAT-range values and the unit answered `invalidSpCoolRange`.
- **Writes are independent:** each threshold sends only its own field. 1.5.2 powered-off guard
  (cache + echo) and revert on failure.
- Code: `accessory.ts:get/setHeatingThresholdTemperature, get/setCoolingThresholdTemperature,
  setThresholdTemperature, quantize, setpointRanges, setThresholdRange`

### Fan-only switch

HeaterCooler has no fan-only mode, so it's a second `Switch` service per accessory (subtype `fan-only`).

- **Capability-gated:** added once the profile reports `hasModeVent === true` (and
  `showFanOnlySwitch !== false`); removed otherwise.
- **Switch ON** → `sendCommand({ operationMode: 'vent', power: 1 })`
- **Switch OFF** → `sendCommand({ operationMode: 'off', power: 0 })` — turns the unit off entirely
- The `power` field is sent explicitly on the switch paths to match the verified v3 cloud reference ([EnumC/ha_kumo_ws](https://github.com/EnumC/ha_kumo_ws)); the power/mode path omits `power` since the API derives it from `operationMode`.
- Kept in sync with streaming/polling: ON iff `power === 1 && operationMode === 'vent'`.
- Power/mode changes set both switches from the resulting status. Engaging the switch refreshes
  the HeaterCooler (Active, IDLE, target COOL) via `refreshClimateCharacteristics`.
- History: through 1.x on the Thermostat, 1.7.1 had to report vent (and dry) as COOL so an off
  scene wasn't suppressed as Off→Off. HeaterCooler's separate `Active` makes that unnecessary.
- Code: `accessory.ts:setupFanOnlySwitch / removeFanOnlySwitch / setFanOnlyOn / isFanOnlyActive`

### Dry switch

Same shape as fan-only: a separate `Switch` (subtype `dry`).

- **Capability-gated:** `hasModeDry === true` (a real top-level field in the v3 profile payload — see `API-EXPLORATION-FINDINGS.md`) and `showDrySwitch !== false`.
- **Switch ON** → `sendCommand({ operationMode: 'dry', power: 1 })`; **OFF** → `{ operationMode: 'off', power: 0 }`.
- Kept in sync: ON iff `power === 1 && operationMode === 'dry'`.
- **Mutually exclusive with fan-only:** engaging one optimistically flips the other off; a
  power/mode change sets both from the resulting status. Streaming/polling reconciles.
- **Setpoint (since 1.5.3):** units with `usesSetPointInDryMode === true` accept a target while
  dehumidifying, kept in **`spCool`** (there is no `spDry`). On the HeaterCooler a dry unit
  reports target COOL, so the Home app shows the cooling threshold, which reads/writes `spCool`.
  The profile flag still gates the one place the plugin adds a dry setpoint itself: a
  power-on restoring dry (`attachSameBurstSetpoints`), and the mirror (`applyMirror`).
- Code: `accessory.ts:setupDrySwitch / removeDrySwitch / setDryOn / isDryActive`

## Adapter reachability → HomeKit "No Response" (since 1.10.0)

A unit whose Wi-Fi adapter is offline is surfaced as **No Response** rather than
serving its last known state as if it were live.

**Why:** when an adapter drops off the network the Kumo cloud keeps serving a
**frozen shadow record**. Observed 2026-09-10: the rear bedroom's adapter was off
the LAN for ~22h while `/sites/{id}/zones` still reported `mode=cool power=1
connected=true` with an `updatedAt` from two minutes prior — the unit was physically
off, and three `off` commands each returned HTTP 200 and reached nothing.

**Trap — neither field in the zones payload means what it looks like:**
`adapter.connected` was `true` for an adapter the cloud itself knew was
IoT-Disconnected, and `adapter.updatedAt` ticks on unrelated row touches (a
`profile_update` refresh). The only trustworthy freshness field is `lastUpdated`
from `GET /devices/{serial}/status`. `routerRssi` there is also a *last-reported*
value — the dead adapter still showed a healthy `-49 dBm` from the day before.
Likewise, HTTP 200 from `/devices/send-command` only means the cloud queued it.

**Mechanism:**
- Source of truth is the `device_status_v2` streaming event (logged as "reported
  offline (reason: IoT Disconnected)"). `onDeviceConnectionStatusChange` had existed
  since the streaming work but had **no subscriber** — that was the entire bug.
- `platform.ts` subscribes **before** `startStreaming`, so a unit already offline at
  boot comes up unreachable instead of publishing a stale record.
- `accessory.ts:isReachable()` — unreachable only when the cloud explicitly reports
  the adapter disconnected **and** `localClient.hasLocal(serial)` is false. Local LAN
  control overrides the cloud verdict entirely. `null` (nothing reported yet) counts
  as reachable, so a fresh start never flashes No Response.
- Every getter and setter calls `assertReachable()`, which throws
  `HapStatusError(SERVICE_COMMUNICATION_FAILURE)`. The error is also *pushed* to the
  characteristics on transition so the tile updates without waiting for a read.
- A stale replay arriving while unreachable is cached (so recovery can republish it)
  but is **not** published to HomeKit and does **not** fire the mirror hook — a frozen
  reading must never be pushed onto a live mirror target.
- Recovery republishes real state and clears the error.
- **The cloud doesn't reliably push "connected" (2.0).** It pushed the front bedroom's
  disconnect (2026-09-28 20:42) but nothing when it returned (~21:14), so it sat at No
  Response. `kumo-api.ts:recheckOfflineDevices` re-emits `device_status_v2` for each unit
  marked offline every 60s from the health timer; `handleDeviceStatus` logs the offline
  warning once and "reported online again" on recovery.

**Verifying:** config-ui-x is useless for this — `/api/accessories` returns HTTP 200
regardless and does not propagate HAP error status. Confirm in the Home app, or by
the asymmetry in the log: a write to an unreachable unit produces **no** `[CMD]` or
`[MODE CHANGE]` line at all, because `assertReachable()` throws first.

Code: `accessory.ts:setCloudConnected/isReachable/assertReachable/pushUnreachable/
pushCurrentState`, `platform.ts` (subscription before streaming starts).
Tests: `test/reachability.test.js`.

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

**Credentials** (two per device). **Read `docs/LOCAL-CREDENTIAL-SOURCES.md` before touching
this — both original v3 sources are dead and the details are easy to rediscover the hard way.**

- `password` (base64, 40 chars) — *used to* arrive in the `adapter_update` Socket.IO event
  (captured in `kumo-api.ts`, still stripped from logs). **The event no longer carries it
  as of ~2026-08-01.**
- `cryptoSerial` (hex, 18 chars) — *used to* come from `GET /devices/{serial}/status`
  (`getDeviceCryptoSerial`). **That field is gone too.**
- **The only live source today is the legacy v2 endpoint** `POST https://geo-c.kumocloud.com/login`
  (`fetchLegacyCredentials()`), which still returns both secrets per serial. Verified
  end-to-end 2026-09-12: v2 credentials fetched fresh authenticate against real hardware.
  **v2 is a frozen pre-switchover snapshot.** It returns HTTP 500 for accounts with no old
  record and hasn't picked up any later change we've seen (a 2026-08-05 remove/re-add left
  it unchanged).
  A unit added to the account now gets no local credential from anywhere.
- The credential store `mitsubishi-comfort-local-creds.json` was captured 2026-07-30, about
  25 hours before the v3 shutoff. **It cannot be rebuilt from v3. Back it up off-box.**
- A unit whose v2 entry is stale (ours: front bedroom `0Y34P008Q100142F`) has no recovery
  path we've found. Resets, power cycles, Wi-Fi reconnects and restarts have all been tried.
  So was removing and re-adding it in the Comfort app. The old "re-pair the unit in the app"
  log line was a guess and has been removed.

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
- **A read a command overtook is dropped (2.0):** the poller stamps each read when it
  starts (`readStartedAt`), and `updateFromLocal` drops one that started at or before the
  unit's last command. The poll reads status, then humidity, then applies, so a command
  queued on the unit's lock in between went out first and was undone by the older read.
- **The unit catching up (2.0):** a unit keeps reporting its old state for a moment after
  accepting a command (a read that started 1s after the kitchen's off finished still said
  heat; the cloud had off by 3.3s). For `COMMAND_SETTLE_MS` (15s) after a command,
  `contradictsRecentCommand` drops a LAN read that disagrees with what was sent (mode,
  setpoints ±0.3, fan, vane) and logs `[LOCAL] … waiting for it to catch up`. A read that
  agrees ends the wait; after the window the unit's report wins. Trade-off: a real wall
  change in those 15s shows at the next poll instead.
- **Cloud sync (2.0):** the cloud never sees a LAN command, so the Comfort app showed the
  old state for minutes. `scheduleCloudSync` sends `force_adapter_request iuStatus`
  (`kumo-api.ts:requestDeviceStatus`) 3s after each successful LAN command and logs
  `[CLOUD SYNC]` when a cloud update matches the command's power/mode (or that it hasn't
  after 60s).
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
- **An edge missed while the plugin was down still counts (since 1.8.5).** The first
  observation after a restart seeds the baseline without pushing, so a reboot alone
  never clobbers a manual target state. But the source's signature is persisted, so
  if it *differs* from the one recorded at shutdown the source genuinely moved while
  we weren't running, and the targets are re-synced. See "Mirror state store".
- **Full re-sync on any source change:** any source change re-applies the source's
  *full* state (mode + setpoint(s) + fan). So a source **temperature** change also
  re-syncs mode/power — a manually-off target is turned back on to match.
- **Source-agnostic:** triggers on the source's *observed actual state*, so a wall
  thermostat (MHK2) / IR remote, the Kumo app, and HomeKit all fire it. The plugin
  already watches the unit's real state via streaming + cloud-poll + local-poll; a
  HomeKit change to the source additionally fires immediately via the setter hook.

**Mirror state store (since 1.8.5):** `src/mirror-store.ts` keeps each source's last
signature in `mitsubishi-comfort-mirror-state.json` in the Homebridge storage dir
(same write-then-rename shape as the 1.8.4 credential store). It exists purely so the
controller can distinguish "restarted, nothing changed" from "restarted, and the source
moved while we were down" — the latter is a real edge that used to be swallowed by the
baseline seed. Wired via the optional `MirrorStatePersistence` adapter on the
`MirrorController` constructor; with no adapter the controller keeps its pre-1.8.5
seed-only startup behavior verbatim. Cache, not truth: missing or corrupt degrades to
seed-only and never blocks startup. Holds no secrets.

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

**Startup wait for a LAN read (2.0):** with `localControl` on, the first comparison after
a restart ignores cloud (streaming/polling) observations of the source and waits for a
LAN read or a HomeKit command (`MirrorStartupGate`, `platform.mirrorWaitsForLocal`). The
cloud doesn't see LAN commands; on 2026-09-27 its stale "heat" for the kitchen nearly
re-synced the living room on after a LAN off. Sources that don't make it onto the LAN are
released when local startup ends (`releaseWaiting`), and everything at 3 minutes.
Listeners get the update's source: `onStatusUpdate((status, source) => …)`.

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

**Out of scope:** bidirectional sync, mirroring room temp / humidity (sensor readings,
not settings). Vane direction is mirrored since 2.0 (capable targets only).

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
