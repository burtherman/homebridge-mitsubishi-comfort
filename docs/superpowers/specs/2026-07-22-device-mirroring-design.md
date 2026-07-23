# Device Mirroring — Design

**Date:** 2026-07-22
**Status:** Approved (ready for implementation plan)
**Target version:** 1.8.0

## Problem

The living room unit has no wall control — only the Kumo app. The user wants it to
**follow the kitchen unit**: whatever the kitchen is set to gets mirrored onto the
living room. Native HomeKit can't do this (automations are trigger → static scene;
there is no "copy whatever value" primitive), and a generic HomeKit-layer mirror
plugin would be lossy for these units (dry/vent are surfaced as separate switches,
auto is a two-handle band, dry/vent report "Cooling"). The faithful place to mirror
is the **device-command layer**, which only this plugin has. So the feature lives
here, opt-in.

## Contract

- **One-way:** kitchen (source) → living room (target). Target changes never feed back.
- **Edge-triggered:** the target follows the source **only at the moment the source's
  commanded state changes**. Between source changes the target is free — a manual
  change to the target sticks until the next source change re-syncs it.
- **Full re-sync on any source change:** any source change re-applies the source's
  **full** state (mode + setpoint(s) + fan). Consequence, accepted by design: a source
  **temperature** change also re-syncs mode/power, so a manually-off target is turned
  **back on** to match when the kitchen is nudged. This is exactly "manual change holds
  until the kitchen changes again, then the state mirrors again."
- **Source-agnostic:** triggers on the source's *observed actual state*, not on which
  client issued the command. Wall thermostat (MHK2) / IR remote, the Kumo app, and
  HomeKit all land on the unit and are observed through the plugin's existing
  streaming + cloud-poll + local-poll channels.

## Scope of "everything"

Mirrored fields:

| Field | Notes |
|---|---|
| `operationMode` | off / heat / cool / auto / dry / vent. `autoHeat`/`autoCool` normalize to `auto`. |
| `spHeat` / `spCool` | the mode-appropriate setpoint(s), raw Celsius at 0.1° granularity |
| on/off | carried by `operationMode` (`off`) — no separate power field on the local path |
| `fanSpeed` | **raw passthrough** (see local-api change) so `quiet`/`powerful` aren't flattened |

**Not** mirrored: vane/louver direction (`vaneDir`), room temperature, humidity (those are
sensor readings, not settings), schedules.

## Config (opt-in, zero impact when absent)

```json
"mirror": [
  { "source": "<kitchenSerial>", "target": "<livingRoomSerial>" }
]
```

- Array of `{ source, target }` pairs. One source may drive several targets; a target
  follows exactly one source (last-wins with a warning if duplicated).
- Serials (consistent with `excludeDevices` / `localControlIps`). Resolved to zone
  names in logs. Serials will be pulled off the Pi at implementation.
- Validation at startup: warn and skip an entry whose `source`/`target` serial is not a
  discovered device, or where `source === target`.
- Absent `mirror` → feature entirely inert (no controller constructed).

## Components

### New: `src/mirror.ts` — `MirrorController`
Owns change-detection, debounce, and dispatch. Constructed by the platform after
discovery **iff** `mirror` config is present and non-empty. Holds, per source:
`lastSignature`, a debounce timer, and the resolved list of target handlers.

Public surface:
- `constructor(log, mirrorConfig, handlers: KumoThermostatAccessory[])` — resolves
  serials to handlers, validates, subscribes to each **source** handler's status
  updates.
- Internal `onSourceUpdate(sourceSerial, status)` — compute signature, seed-or-compare,
  debounce, dispatch.

### `src/accessory.ts` (source side) — generic update hook
- Add a lightweight listener list: `onStatusUpdate(listener: (status: DeviceStatus) => void)`.
- Fire it at the **end of `processZoneUpdate()`**, only when an update was actually
  applied (not dropped by the timestamp / local-authoritative guards). This is the one
  chokepoint all three ingest sources funnel through → catches wall-thermostat, Kumo
  app, and any externally-originated change.
- **Also** fire it from the source's own **setters** after a *successful* command
  (`setTargetHeatingCoolingState`, `setTargetTemperature`, `setThresholdTemperature`,
  `setDryOn`, `setFanOnlyOn`) so a **HomeKit** change to the kitchen mirrors promptly
  instead of waiting for the streaming/local echo. The controller's signature-dedup
  makes the later echo a no-op.
- The accessory stays mirror-agnostic — it just emits "I updated" events.

### `src/accessory.ts` (target side) — `applyMirror(desired)`
New public method on the target handler (clamping needs the target's own
`deviceProfile`; the optimistic echo needs its `service`). Given the source's desired
canonical state it:
1. Normalizes mode (`autoHeat`/`autoCool` → `auto`).
2. **Capability guard:** if desired mode is `dry` and `!profile.hasModeDry`, or `vent`
   and `!profile.hasModeVent`, **skip + log** (won't happen for identical models).
3. Builds **one combined `Commands`**:
   - `off` → `{ operationMode: 'off' }` only
   - `heat` → `{ operationMode: 'heat', spHeat: clamp(spHeat), fanSpeed }`
   - `cool` → `{ operationMode: 'cool', spCool: clamp(spCool), fanSpeed }`
   - `auto` → `{ operationMode: 'auto', spHeat: clamp(spHeat), spCool: clamp(spCool), fanSpeed }`
   - `dry`  → `{ operationMode: 'dry', spCool: clamp(spCool)?, fanSpeed }` (spCool only if
     `usesSetPointInDryMode`)
   - `vent` → `{ operationMode: 'vent', fanSpeed }`
   - `fanSpeed` omitted when mode is `off`.
4. **Clamps** setpoints to the target's profile min/max (per mode). Profile not yet
   loaded → send unclamped (best effort; profiles load early).
5. Sends via the existing private `sendDeviceCommand()` (local-first, cloud fallback).
   A single combined command is atomic — the 1.7.2 trailing-setpoint race cannot recur.
6. On success: optimistic update of the target's `currentStatus`, thermostat
   characteristics, and Dry/Fan switches (mirrors the pattern in the existing setters);
   next poll reconciles. On failure: log; next poll reconciles.

`applyMirror` does **not** go through `shouldSuppressSetpoint` — it always sends a
mode-bearing combined command, so the off-suppression guard (which protects bare
setpoint writes) is irrelevant to it.

### `src/local-api.ts` — raw fan-speed passthrough
`buildLocalCommandBody` currently maps `fanSpeed` through the coarse
`auto/low/medium/high` enum, flattening anything else to `auto`. Add a raw passthrough
so a mirrored `quiet`/`powerful`/etc. reaches the adapter verbatim. Approach: carry the
raw source fan-speed string and, when present, write it to `status.fanSpeed` without the
coarse mapping. (`Commands.fanSpeed` widened, or a dedicated `fanSpeedRaw` field used
only by the mirror path — decide in the plan; keep the coarse enum intact for the
existing switch paths.)

### `src/settings.ts` / `config.schema.json`
- `KumoConfig.mirror?: Array<{ source: string; target: string }>`.
- `config.schema.json`: a `mirror` array with `source` / `target` string items, titled
  for the Homebridge UI, documented as opt-in.

## Change detection

Per source, keep a **mode-aware signature**; push only when it changes:

| Source mode | Signature |
|---|---|
| off | `off` |
| heat | `heat` + spHeat + fan |
| cool | `cool` + spCool + fan |
| auto | `auto` + spHeat + spCool + fan |
| dry | `dry` + spCool + fan |
| vent | `vent` + fan |

- Setpoints rounded to 0.1 before hashing (kills float jitter).
- **Mode-aware** so a drifting *inactive* setpoint (e.g. spCool wandering while in heat —
  which the Home app doesn't even show) can't spuriously re-clobber the target.
- **Startup baseline seed:** the first source state observed after (re)start seeds
  `lastSignature` **without pushing** — a restart isn't "someone changed the kitchen," so
  a manually-set target survives a reboot. Subsequent changes push.

## Dispatch

- On a detected change, wait a **~1s debounce**, then push the *settled* source state to
  each target via `target.applyMirror(desired)`. Debounce collapses a mode+setpoint burst
  (or a fast setpoint drag) into a single push and eases the target's per-device local
  mutex.
- The controller stores the **latest** `DeviceStatus` each `onStatusUpdate` delivers;
  when the debounce fires it pushes that latest snapshot (mode + spHeat + spCool +
  fanSpeed). No separate getter — the last event payload before the timer fires is the
  settled state. Source setters must mutate `currentStatus` **before** firing the hook so
  the payload is already updated.

## Latency (honest)

| Kitchen changed via | Living room follows within |
|---|---|
| HomeKit | ~1s (debounce), via the setter hook |
| Wall thermostat (MHK2) / Kumo app | one local poll (~15s with `localControl` on) or a streaming / cloud-poll tick |

Not instant for wall/app changes, but seconds — fine for HVAC. Lever for faster
wall/app mirroring: a shorter `localPollInterval`.

## Edge cases / defaults

- **Manual target change persists** — inherent: no source change → no push.
- **Target can't do the source's mode** (`dry`/`vent` unsupported) → skip that change +
  warn. (Moot for identical models.)
- **Setpoint out of target range** → clamped to the target's limit.
- **One-way** → no feedback loop; target updates never trigger anything.
- Mirror uses the normal `sendDeviceCommand` path, so the target's local-authoritative
  window and OFF-suppression behavior are untouched.
- **`localControl` off** → still works; the source is observed via streaming/cloud-poll
  and the target is driven via the cloud. Local control just makes both faster/more
  reliable.

## Testing

`node:test` (run via `npm test`, globbing `test/*.test.js`):

**Controller (`test/mirror-controller.test.js`):**
- edge-fire: a changed signature pushes; an unchanged repeat does not.
- manual-target-persist: a target-only change does not re-trigger (source unchanged).
- startup baseline seed: first source observation pushes nothing.
- debounce coalesce: a burst of source updates yields one push of the settled state.
- mode-aware: an inactive-setpoint change (spCool while in heat) does not trigger.
- full re-sync: a source temp change pushes the full `{mode, setpoint}` (revives an
  off target).

**Target `applyMirror` (`test/mirror-apply.test.js`):**
- combined-command shape per mode (off → mode-only; heat/cool/auto/dry/vent).
- `autoHeat`/`autoCool` → `auto` normalization.
- setpoint clamp to target profile.
- capability skip when target lacks `dry`/`vent`.
- fan speed carried (and omitted for `off`).

**Local API (`test/local-api.test.js` extension):**
- raw fan-speed passthrough reaches `status.fanSpeed` verbatim; coarse enum still maps
  for the existing switch paths.

**Live on the Pi (verify-before-done):**
- Change the kitchen (HomeKit, then the Kumo app, then — if reachable — the wall
  control); confirm the living room follows, including exact °F setpoint round-trip.
- Manually nudge the living room; confirm it holds until the next kitchen change.
- Confirm a kitchen temperature-only change re-syncs a manually-off living room back on.

## Out of scope

- Vane/louver mirroring, bidirectional sync, mirroring room temp / humidity, schedule
  mirroring.

## Files touched

- **New:** `src/mirror.ts`, `test/mirror-controller.test.js`, `test/mirror-apply.test.js`
- **Edit:** `src/accessory.ts` (status-update hook + setter hooks + `applyMirror`),
  `src/platform.ts` (construct the controller after discovery), `src/local-api.ts` (raw
  fan passthrough), `src/settings.ts` (`mirror` config type), `config.schema.json`,
  `CLAUDE.md` (version history + mapping notes), `README.md` (feature + config docs)
