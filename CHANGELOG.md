# Changelog

All notable changes to homebridge-mitsubishi-comfort.

- **1.8.5** - Mirror a source change that happened while the plugin was down (August 2026)
  - Fixed: **a mirror target silently diverged across an outage.** Mirroring is edge-triggered, and the first source observation after a restart deliberately seeds the baseline *without* pushing — a reboot isn't "someone changed the kitchen", so a manually-adjusted target survives it. That same rule also swallowed a source change that happened while the plugin was **down**, which is a real edge we simply weren't running to observe. The controller had no way to tell the two apart: both look like "first observation, signature X"
  - Observed live 2026-08-05: `hb-service update-node` left a **truncated Node binary** (83,431,529 bytes against an ELF section table pointing at byte 122,075,032 — 38.6 MB missing, `npm` never extracted), Homebridge crash-looped on SIGSEGV every 5s for 41 minutes (458 crashes). The kitchen was switched on at the wall during the outage. When Homebridge came back the mirror seeded its baseline from the already-changed state, and the living room sat `off` against a kitchen at `cool / 24.5` with nothing left to re-sync them — a restart of the child bridge only re-seeded the baseline again
  - Fix: each source's signature is now **persisted across restarts** (`mitsubishi-comfort-mirror-state.json` in the Homebridge storage dir, same write-then-rename pattern as the 1.8.4 credential store). On the first observation after startup the controller compares: **unchanged** since shutdown → seed silently exactly as before, so a manual target change still survives a reboot; **different** → the source moved while we were down, so the targets are re-synced. The store is a cache, never a source of truth — missing or corrupt degrades to precisely the old seed-only behavior and never blocks startup. Signatures carry no secrets (mode, setpoints, fan speed)
  - The mirror contract is otherwise unchanged: still one-way, still edge-triggered, still free between source changes
  - `node:test`: `test/mirror-restart-resync.test.js` (10 cases: the outage case re-syncs, an unchanged source still seeds silently, first-ever run seeds, no-persistence-adapter keeps legacy behavior, a mid-run change persists its signature, the re-sync doesn't re-fire on a second restart, plus store round-trip / missing / corrupt / no-stray-temp-file). **132 tests total green**
  - Code: `src/mirror-store.ts` (new), `mirror.ts:onSourceUpdate` + `MirrorStatePersistence`, `platform.ts:initMirrorStore/mirrorPersistence`
- **1.8.2** - Keep retrying for local credentials; stop a scene setpoint from rewriting a mirror target (July 2026)
  - Fixed: **units silently stranded on the cloud for the life of the process.** The local password arrives only via the `adapter_update` socket event, and `initLocalControl` waited a fixed 25s for it before giving up for good. Measured on real hardware 2026-07-26: of five units, two answered the nudge in 6s, one took **65s** (well past the window), and two never answered at all — so a healthy unit could miss the window by timing alone and never get local control, losing the fast LAN path and its per-unit cloud fallback
  - Fix: the 25s startup gather is unchanged, but any device still missing credentials is now **re-nudged every 60s in the background** and admitted to local control the moment its credentials arrive (starting local polling if it isn't already running). A nudge is a single socket emit, so retrying costs nothing; the expensive LAN sweep runs only when a device actually hands over its credentials. The retry stops once every device is local, and is torn down on shutdown. This also means a unit whose adapter is wedged rejoins local control **automatically** when it recovers, instead of needing a Homebridge restart
  - Fixed: **a scene setpoint dispatched just *before* an off permanently rewrote the device's stored setpoint.** The 1.7.2 guard only suppresses setpoints that land *after* the off; HomeKit dispatches a scene's captured setpoints and its off concurrently in arbitrary order, so one landing first arrives while the unit is still on, passes the guard, and sends. Observed live 2026-07-26 (19:26:56 burst): the "AC off" scene wrote the living room's stale captured `spCool` of 25°C, then turned it off. The living room is a mirror target of the kitchen (22.5°C), and mirroring is edge-triggered — nothing re-synced them until the kitchen next changed, so the two tiles sat 2.5°C apart for 36 minutes
  - Fix: each setpoint write is **held ~1.5s before being sent**, so an off arriving in the same burst cancels it whichever order the two were dispatched in. Writes are keyed per setpoint (the two AUTO handles stay independent) with a generation counter, so a drag now sends only its final value instead of every intermediate one. The mirror contract is unchanged — the target is still free between source changes; what's fixed is a scene write the user never intended
  - `node:test`: `test/local-cred-retry.test.js` (7 cases: late-arriving credentials are admitted, only stragglers re-nudged, retry stops when complete, overlapping passes suppressed, cleanup clears the timer) and `test/off-scene-pre-setpoint.test.js` (5 cases, RED→GREEN on the pre-off ordering for both the threshold handles and plain `TargetTemperature`, plus drag-supersede; two controls pass either way). **104 tests total green**
  - Code: `platform.ts:initLocalControl/gatherLocalCreds/admitLocalDevices/scheduleLocalCredRetry/retryLocalCreds`, `accessory.ts:holdSetpointWrite/setTargetTemperature/setThresholdTemperature`
- **1.8.1** - Don't let a stale cloud reading revive a mirror target after an off (July 2026)
  - Fixed: an "AC off" skylight scene turned all units off, but the **living room (mirror target) came back on** while the **kitchen (source) stayed off**. Root cause was a stale cloud reading driving the mirror, not the mirror logic itself: the scene turned the kitchen off over the LAN, but the Kumo cloud lags ~7-10s and a streaming `device_update` still reporting the kitchen as `cool` arrived a few seconds later. The plugin normally ignores cloud/streaming while a local read is recent (the 45s `LOCAL_AUTHORITATIVE_MS` guard), but **only a local *poll* refreshed that window — a local *command* did not**. During the all-units command burst the kitchen's local poll was starved, the window lapsed, the stale `cool` was applied, briefly flipping the kitchen's cached state back on, which fired the source `onStatusUpdate` hook → the mirror sent a **real `cool` command to the living room**. The kitchen self-corrected on its next local poll, but the living room was already physically on and stayed on (edge-triggered — nothing re-pushed off)
  - Fix: a **successful local command now refreshes `lastLocalUpdateTs`** (marks the unit local-authoritative), exactly as a local poll does. After an `off` the cloud's lagging `cool` is dropped for the 45s window — during which local polls confirm the real `off` — so the kitchen's cached state never flips back on and the mirror never fires a phantom revive. Also fixes the kitchen's *own* tile flickering back to "Cooling" for a few seconds after an off. The mirror is untouched — it still follows the kitchen faithfully; a genuine local change (wall thermostat / Kumo app, observed via local poll) still mirrors normally
  - One-line change in `accessory.ts:sendDeviceCommand` (bump `lastLocalUpdateTs` on local-command success)
  - `node:test` regression (`test/mirror-stale-revive.test.js`, 2 cases): a stale cloud `cool` after a local `off` must NOT re-fire the source hook (reproduced the exact `[off, cool]` signature RED→GREEN); a *real* local change after an `off` still fires it (following preserved). 92 tests total green
  - **Live-verified on the Pi (2026-07-23):** hand-patched + restarted; drove kitchen→cool (mirror carried cool@24 to living in ~11s), kitchen→off (mirror carried off in ~15s), living room held off for ~3 min with no phantom `cool` push
  - Code: `accessory.ts:sendDeviceCommand`
- **1.8.0** - Device mirroring: one unit follows another (July 2026)
  - **Opt-in** via a `mirror` array of `{ source, target }` device-serial pairs (default absent → inert). Makes `target` follow `source`: whenever the source's commanded state changes, the source's full state (mode + setpoints + on/off + fan) is copied to the target. Built for a unit with no wall control (living room) to shadow one that has it (kitchen)
  - **Edge-triggered + one-way:** the target follows the source only at the moment the source changes; between changes the target is free (a manual target change holds until the next source change). Any source change re-applies the source's *full* state, so a source temp change also re-syncs mode/power (revives a manually-off target — by design)
  - **Source-agnostic:** triggers on the source's *observed* state, so wall thermostat (MHK2) / IR remote, Kumo app, and HomeKit all fire it. Fired from `processZoneUpdate` (observed changes) + every setter (instant HomeKit changes). Change detection is a **mode-aware signature** (mode-relevant setpoints + fan, rounded 0.1) so inactive-setpoint drift can't spuriously re-clobber the target; first observation after startup seeds the baseline without pushing
  - **Faithful + safe push:** `applyMirror` normalizes `autoHeat`/`autoCool` → `auto`, clamps setpoints to the target's own range, skips modes the target can't do, and sends **one combined atomic command** (so the 1.7.2 trailing-setpoint race can't recur) via the local-first path. Fan speed mirrored verbatim via new `Commands.fanSpeedRaw` (bypasses the coarse enum locally; folded into `fanSpeed` on cloud)
  - New `src/mirror.ts` (`MirrorController` + `signature`/`toMirrorState`); `accessory.ts` (`onStatusUpdate`/`notifyStatusListeners` source hook, `applyMirror`/`clampSetpoint`/`normalizeMirrorMode` target side); `platform.ts` (construct/teardown); `local-api.ts` + `kumo-api.ts` (`toCloudCommands`) fan passthrough; `settings.ts`; `config.schema.json`
  - `node:test`: `test/mirror-controller.test.js`, `test/mirror-apply.test.js`, `test/mirror-hook.test.js`, `test/local-fanspeed-raw.test.js`. 90 tests total green
  - Spec: `docs/superpowers/specs/2026-07-22-device-mirroring-design.md`. See "Device Mirroring"
- **1.7.2** - Don't let an "AC off" scene revive the unit it's turning off (July 2026)
  - Fixed: an "AC off" HomeKit **scene** could leave a unit **running (in dry)** right after it fired. A scene is a saved snapshot of each thermostat's full state, so on every trigger it re-pushes `TargetHeatingCoolingState = OFF` *and* the captured setpoints — `TargetTemperature`, and for an AUTO unit the two AUTO band handles (`HeatingThresholdTemperature`/`CoolingThresholdTemperature`). HomeKit dispatches these concurrently in an arbitrary order. A setpoint dispatched **after** the off reached the LAN adapter as a bare, mode-less write (local commands carry no `power` field — `mode` alone carries on/off, see `local-api.ts`), which powered the unit back **on** in its prior mode
  - Root cause: the 1.5.2 powered-off guard suppresses a setpoint only when the *cached* mode already reads off. During the concurrent scene burst the off command's optimistic state update hasn't landed yet, so setpoint handlers still see "on" and send a live command. With local control, that trailing bare setpoint revives the unit
  - **1.7.1 connection:** before 1.7.1 a dry unit read `TargetHeatingCoolingState = OFF`, so iOS suppressed the off write entirely — there was no off for the setpoints to race (the unit just never turned off, the original 1.7.1 bug). 1.7.1 made the off fire, which *exposed* this race
  - Fix: a HomeKit off request opens a short suppression window (`offRequestedAt`, set synchronously via `noteModeIntent()` **before** the off command's await, so sibling handlers in the same burst observe it). While the window is open — or the unit already reads off — `shouldSuppressSetpoint()` returns true and `setTargetTemperature` / `setThresholdTemperature` cache + echo the value to HomeKit **without sending**, so the off is the last thing the adapter sees. Any active-mode command (heat/cool/auto, dry-on, vent-on) clears the window. Setpoints dispatched *before* the off are harmless — the off follows and wins. Given the LAN per-device mutex serializes in dispatch order, the unit reliably ends off
  - **Live-verified end-to-end on the Pi (2026-07-11):** Living room (the AUTO unit, whose scene pushes `TargetTemperature` + both AUTO handles). Two runs — the off was accepted and **all three setpoint writes were suppressed** (only `OFF` reached the device); the unit turned off and stayed off (confirmed via the cloud once its local-control sync lag caught up). Also empirically proved a HomeKit-side workaround is *not* enough: re-recording the scene while the unit was off did **not** stop HomeKit from replaying the setpoints — the plugin fix is what holds the line
  - `node:test` regression (`test/off-scene-setpoint-race.test.js`, 3 cases): replays Living's exact concurrent dispatch order and asserts no setpoint follows the off; a threshold write in the same burst as an off is suppressed; a threshold write with no recent off still sends (control). Watched RED→GREEN. 60 tests total green
  - Code: `accessory.ts:noteModeIntent / shouldSuppressSetpoint / setTargetHeatingCoolingState / setTargetTemperature / setThresholdTemperature / setDryOn / setFanOnlyOn`
- **1.7.1** - Dry/vent units now respond to a thermostat "off" (July 2026)
  - Fixed: a unit running in **dry** (or fan-only **vent**) would not turn off when a HomeKit scene/automation set the thermostat to Off. Root cause: dry/vent have no HomeKit Thermostat state, so the plugin reported the Thermostat as **OFF** while the unit ran (dry/vent were surfaced only through their separate Dry/Fan switches). An off-automation writes `TargetHeatingCoolingState = OFF`; since the thermostat already read OFF in dry, iOS suppressed the redundant write, the setter never fired, no `operationMode:'off'` reached the unit, and the still-ON Dry/Fan switch kept it running
  - Fix: dry/vent now map to **COOL** on both `mapToTargetHeatingCoolingState` (so the off-write is a real COOL→OFF transition iOS sends) and `mapToCurrentHeatingCoolingState` (so a running dry/vent unit shows as on — "Cooling" — instead of a misleading "Off"; matters because the Dry/Fan switches are often invisible on already-paired accessories per the 1.5.1 cache caveat). COOL fits dry naturally — its setpoint already lives in `spCool`. The optimistic updates in `setDryOn`/`setFanOnlyOn` now derive from these maps so there's no window where the Target is still OFF right after engaging the switch. Dry/vent are still *set* via their dedicated switches; the thermostat OFF path (`operationMode:'off'`) is unchanged and mode-agnostic
  - **Trade-off:** the tile reads "Cooling" while dehumidifying (HomeKit has no dry/fan state), and any "if AC is cooling" automations will trip on dry/vent. Chosen deliberately over a running unit looking "Off"
  - Live-verified end-to-end on the Pi (2026-07-10): Rear bedroom set to dry via the Kumo app, the off automation fired, `[MODE CHANGE] Rear bedroom: HomeKit sent OFF mode` appeared (it was suppressed before the fix) and the unit powered down — confirmed off in the Kumo app
  - `node:test` regression (`test/dry-off-thermostat.test.js`, 9 cases): dry/vent Target non-OFF (COOL), dry/vent Current COOL, genuinely-off still OFF, heat/cool unchanged, off-command still routes to `operationMode:'off'`, optimistic-window Target non-OFF. Watched RED→GREEN. 57 tests total green
  - Code: `accessory.ts:mapToTargetHeatingCoolingState / mapToCurrentHeatingCoolingState / setDryOn / setFanOnlyOn`
- **1.7.0** - Local LAN control + 0.1°C setpoint step (June 2026)
  - **Opt-in local control** (`localControl: true`, default off): control/read each unit directly over the LAN, falling back to cloud per-unit; cloud streaming stays as the fallback. Modeled on HA's `mitsubishi_comfort` integration. See the "Local LAN Control" section
  - New `src/local-api.ts`: the pykumo token algorithm (live-verified against real hardware — a signed status read returned 200, and a command was accepted), `LocalKumoClient` (per-device mutex + forgiving timeout), command/status mapping (`mode`/`vaneDir`, no `power`, 0.1 rounding), and LAN discovery (sweep + token-match, since the cloud gives no IP/MAC)
  - Credentials reuse what we already see: local `password` from the `adapter_update` socket event (was stripped + discarded), `cryptoSerial` from `/devices/{serial}/status` (was fetched + unused)
  - Local-authoritative status: while a local poll is fresh (≤45s), cloud updates are dropped so the cloud's ~7–10s lag can't clobber it
  - **0.1°C setpoint step** (`minStep` 0.5→0.1 on TargetTemperature + the AUTO threshold handles): HomeKit is Celsius-native, so 0.5 forced "72°F" to snap to 22.5°C and read back as 73°F in the Kumo app. 0.1 lets 72°F store as ~22.2°C and round-trip faithfully. Live-verified the units honor 0.1°C (the cloud stored a 23.3 setpoint exactly). Applies to the cloud path too
  - Live-verified end-to-end on the Pi: 5/5 units discovered + controlled locally, polling at 15s, zero errors; the deployed module's read + command both round-tripped against hardware
  - `node:test`: `test/local-api.test.js` (13 cases) + `test/local-integration.test.js` (6 cases) — token, command builder, status mapping, subnet enumeration, local-first routing, cloud fallback, local-authoritative drop. 48 tests total green
  - Code: `src/local-api.ts`, `platform.ts`, `accessory.ts`, `kumo-api.ts`, `settings.ts`, `config.schema.json`
- **1.6.0** - AUTO-mode dual setpoints (June 2026)
  - In AUTO the Home app now shows a temperature range (two handles) instead of a single collapsed setpoint. Exposes the optional `HeatingThresholdTemperature` (↔ `spHeat`, low/heat edge) and `CoolingThresholdTemperature` (↔ `spCool`, high/cool edge) on the Thermostat service
  - Before: in AUTO the plugin returned only the single `TargetTemperature`, which fell back to `spHeat` because these units report `spAuto: null` — so the cooling edge of the band was invisible and unsettable
  - Live-confirmed (real account + Pi): all 5 units report `autoModeDisable: false` (auto IS supported) and `spAuto: null` (so AUTO uses the `spHeat`/`spCool` band, not a single center). End-to-end on Front bedroom via config-ui-x: AUTO engaged, cooling handle → `{spCool}` and heating handle → `{spHeat}` independently (no clobber), cloud held the band across a streaming reconcile
  - Writes are independent and inherit the 1.5.2 powered-off guard (cache + echo, no `modeRequiredWhenDeviceOff` 400) + revert-on-failure. Zone/streaming updates sync both handles. `TargetTemperature` and the HEAT/COOL/DRY paths are untouched (additive change)
  - Characteristics added in the constructor so they publish via the normal discovery path; props set from the device profile range in `applyDeviceProfile`
  - `node:test` regression (`test/auto-setpoint.test.js`, 9 cases): read sync, independent spHeat/spCool writes, the two-handle drag staying two-sided, off-guard, and heat/cool controls proving no regression. 29 tests total green
  - Code: `accessory.ts:getHeatingThresholdTemperature / getCoolingThresholdTemperature / setThresholdTemperature / applyDeviceProfile / processZoneUpdate`
- **1.5.3** - Route the Dry-mode setpoint to `spCool` (June 2026)
  - Fixed: in Dry mode the plugin read and wrote the temperature setpoint to `spHeat`, but the Kumo v3 cloud keeps the dry setpoint in `spCool` (there is no `spDry` field). So dry-mode temperature changes silently did nothing — the cloud accepted the `spHeat` write but the unit ignored it, and out-of-range values 400'd with `invalidSpHeatRange`. Reads surfaced the wrong field (e.g. a unit in dry reporting `spCool=25, spHeat=23` showed 23°C)
  - Live-confirmed (real account, `app-prod.kumocloud.com/v3`): four dry captures held the setpoint in `spCool`; `GET /devices/{serial}/profile` returns `usesSetPointInDryMode: true`; a `POST /devices/send-command {commands:{spCool:24}}` round-trip was adopted and the unit stayed in dry (no flip to cool, no `operationMode` needed)
  - Fix: explicit `dry` branch in both `setTargetTemperature` (write → `{ spCool }`) and `getTargetTempFromStatus` (read → `spCool`), gated on a new `dryUsesSetpoint()` helper. Surfaced `usesSetPointInDryMode` from the `profile_update` payload (was dropped) into `DeviceProfile`. The gate defaults to "has a setpoint" until the async profile loads, so the common case works immediately; units reporting `usesSetPointInDryMode: false` stay setpoint-less (write falls through to the heat branch, read uses the existing fallback)
  - HomeKit: corrective + additive. A dry unit reads as `TargetHeatingCoolingState === 0` (OFF) on the Thermostat, so the stock Home app surfaces no dry-setpoint UI; this fixes the value/route for clients that read the raw `TargetTemperature` characteristic. Heat/cool/auto untouched. The 1.5.2 off-guard is unaffected (a dry unit has `power===1, operationMode==='dry'`)
  - `node:test` regression (`test/dry-setpoint.test.js`): dry write→`{spCool}`, dry write before profile loads→`{spCool}`, gated-false dry→`{spHeat}`, cool/heat controls, dry read→`spCool`, gated-false read→fallback. Proven to fail the 3 core cases against the pre-fix build
  - Code: `accessory.ts:setTargetTemperature / getTargetTempFromStatus / dryUsesSetpoint`, `settings.ts:DeviceProfile`, `kumo-api.ts:profile_update handler`
- **1.5.2** - Don't send a setpoint to a powered-off unit (June 2026)
  - Fixed: setting a TargetTemperature while a unit is off sent a bare `{ spHeat }` with no `operationMode`, which the Kumo v3 API rejects with `modeRequiredWhenDeviceOff` (HTTP 400). Every such attempt logged a cluster of red errors (`Request failed with status: 400` → `Send command failed` → `Failed to set target temperature`)
  - Real-world trigger: a HomeKit automation/scene that turns the AC off (e.g. "off when the skylight opens") captures each thermostat's *full* state, so firing it re-pushes the last setpoint alongside `off`. The `off` succeeded; the trailing setpoint on the now-off unit produced the 400s. The "all units, same second, `HomeKit sent`" log signature distinguishes a controller-pushed burst from a user tap
  - Fix: `setTargetTemperature` now short-circuits when `power === 0 || operationMode === 'off'` — it caches the value and echoes it to HomeKit (so the slider holds) without sending a doomed command. Heat/cool/auto paths unchanged
  - `node:test` regression (`test/setpoint-while-off.test.js`): off → no command sent (failed pre-fix with `1 !== 0`), off → value still echoed, heat → setpoint still sent (control)
  - CI: bumped `actions/checkout` and `actions/setup-node` to `@v5` in `publish.yml` ahead of the 2026-06-16 Node-20 runner deprecation (no functional change to publishing)
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

---

## Historical implementation notes

Design narrative for the streaming and adaptive-polling work, moved out of `CLAUDE.md`.

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
