# 2.0: HeaterCooler, fan speed and vanes, ported from the fork

**Status:** approved 2026-09-27. Stages 1–3 shipped in 1.10.4. Stage 4 (HeaterCooler core) done on
branch `feat/heatercooler`, not released. Stages 5–7 remain before 2.0.0. README and CLAUDE.md on
that branch already describe stage 4.

Stage 4 went beyond the plan: power and mode writes from one HomeKit request are combined into one
command, and a setpoint written while off in the same burst joins the power-on command (the
1.x Thermostat lost it). See CLAUDE.md "Power and mode (2.0)".

## Why

`homebridge-mitsubishi-heatpump` (ukaratay, Apache-2.0) is a hard fork of this plugin at
upstream v1.8.2 (`49549b77`), verified by Homebridge on 2026-08-04
([homebridge/plugins #1151](https://github.com/homebridge/plugins/issues/1151)). It moved the
primary service from `Thermostat` to `HeaterCooler` and added fan speed, vane swing/tilt and
sensor reads. It has none of upstream's post-fork work (v2 credential fallback, credential
store, mirror restart persistence, zombie detection, MAC→ARP discovery, No Response).

HeaterCooler fits these units better (confirmed in hap-nodejs' service definitions):

- `Active` is power, separate from mode (AUTO/HEAT/COOL only). An "off" scene is always a real
  1→0 transition, even for a unit in dry or fan-only. That was the 1.7.1 bug.
- `CurrentHeaterCoolerState` has IDLE, so compressor standby can show.
- Optional `RotationSpeed` and `SwingMode` put fan speed and swing on the tile.
- Heat uses `HeatingThresholdTemperature`, cool uses `CoolingThresholdTemperature`, 1:1 with
  `spHeat`/`spCool`, instead of one `TargetTemperature` that changes meaning by mode.

Cost: every automation or scene that binds the thermostat must be rebuilt. For the owner's
install that's one automation (the roof skylight opening turns off all units).

## Decisions (owner, 2026-09-27)

1. **Manual port, not cherry-pick.** Upstream `accessory.ts` changed in the same places after the
   fork (`assertReachable` in every handler, origin labels on `sendDeviceCommand`, reachability
   in the update path), and the fork rewrote its own fan code five times. Take the final shape
   from fork HEAD `83dfd18`; take JS tests from fork `44fb5f5` (last commit before its TS test
   conversion). Every port commit says "Ported from ukaratay/homebridge-mitsubishi-heatpump@<sha>"
   and credits the fork author.
2. **Fix the fork's power-on bug.** Its `setActive` ON reuses the current mode, which is `'off'`
   for an off unit, so it falls back to AUTO (fork `accessory.ts:1377-1380`, `defaultOnMode`);
   `previousOperationMode` is overwritten with the current mode on every update (fork 842, 948).
   Track the last active mode in accessory context; use it for power-on and for the target shown
   while off. Send power + mode as one command so a scene can't race them.
3. **Dry and Fan switches stay shown by default** (hide via config; their on/off state always
   follows the unit's real mode). The fork made them opt-in
   (`=== true`, fork 558-571), which would delete them on upgrade. They're the only automations
   that survive the service change.
4. **Vane controls only on units whose profile reports `hasVaneDir`/`hasVaneSwing`.** The owner's
   units have fixed vanes, so vane is tested by a volunteer (miketartaglia, issue #6) on a beta.
5. **Attribution:** add `NOTICE` (fork copyright "Copyright 2026 Durmus Karatay" for ported
   parts, and pykumo's MIT notice "Copyright (c) 2019 dlarrick", owed since `local-api.ts` was
   first ported), a "Portions derived from homebridge-mitsubishi-heatpump, modified" header on
   each file that takes fork code, `LICENSE` + `NOTICE` in `package.json` `files`, a README credit
   section, and a statement of changes in the CHANGELOG.

## Stages

Each stage builds, passes `npm test`, and is committed before the next.

1. **Test harness.** `test/helpers.js` from fork `44fb5f5`, but with HAP enum values derived from
   `require('hap-nodejs')` rather than copied. The hand-rolled fake in 13 test files gives every
   characteristic AUTO=3 and has no `Active.ACTIVE`.
2. **Standalone modules.** `src/temperature.ts` (°F-anchored setpoint grid) + test; fan/vane
   vocabularies in `settings.ts` (fork `normalizeFanSpeed`, settings.ts:297); local vane write and
   validated fan vocabulary (fork local-api.ts:222-256); cloud `vaneDir`→`airDirection` (fork
   kumo-api.ts:36+). Not wired into HomeKit yet.
3. **Status hygiene (ships as 1.10.4).** Carry fan speed and vane forward when a cloud zone poll
   omits them (`zone.adapter.fanSpeed ?? this.currentStatus?.fanSpeed ?? 'auto'`) so the mirror
   signature doesn't flip between poll and streaming; carry standby/defrost/filter across status
   rebuilds; stop the humidity getter doing network I/O that overwrites cached status with a
   connection-status payload (upstream accessory.ts ~1723-1735). Plus `NOTICE`.
4. **HeaterCooler core (2.0).** Remove cached Thermostat service on load (fork 186-193), `Active`
   with last-mode fix, thresholds live in every mode with per-mode bounds (fork 479-504), mode
   guard, HumiditySensor service replacing `CurrentRelativeHumidity` (not valid on HeaterCooler;
   `showHumiditySensor`, default on), filter service linked. Port setpoint hold unchanged (the
   `'target'` key goes away). Reachability: `pushUnreachable`/`pushCurrentState` and
   `assertReachable()` cover every new characteristic. Mirror: `applyMirror` optimistic echo moves
   to HeaterCooler chars; every new setter calls `notifyStatusListeners()` on success. Rewrite the
   13 Thermostat-bound test files using the fork's JS tests (`auto-setpoint`, `dry-off-thermostat`,
   `off-scene-*`, `setpoint-while-off`, `off-guard-mode`).
5. **Fan service.** Fanv2 with 5 positions + Auto, fan-tile OFF refused, write coalescing
   (fork 1539-1839). `fan-service.test.js`.
6. **Vane.** `SwingMode` on the tile, opt-in `Slats` (`exposeVaneSlat`, default off: Apple Home
   files Slats under window coverings). Add vane to the mirror signature, and **bump the mirror
   store to `version: 2`, discarding other versions on load**, or the first restart after upgrade
   reads the new signature format as "the source changed while we were down" and pushes the
   kitchen onto the living room. Extend `mirror-restart-resync.test.js` to prove it doesn't.
7. **Schema, docs, release 2.0.0.** Config: `showDrySwitch`/`showFanOnlySwitch` (default true),
   `showHumiditySensor` (true), `exposeVaneSlat` (false). CLAUDE.md: mapping table, setpoint hold,
   AUTO, switches (retire the 1.7.1 wording), reachability list, mirror, local control; new Fan
   and Vane sections.

## Skip

- Fork config validation, schema `required`, `supports-hap`: done upstream in 1.10.3.
- Fork `scheduleSetpointReconcile` (fork 2121-2161): an extra local read against an adapter that
  tolerates about one connection; upstream's 15s local poll already reconciles.
- Fork `44fb5f5` "dead code" deletions: it removes `onDeviceConnectionStatusChange`, which
  upstream reachability depends on.
- Fork TS test conversion. Borrow only "derive HAP constants from the library".
- Fork cloud `sensor_update` + Battery service: independent of HeaterCooler, defer to 2.1.
- node-fetch → built-in fetch: separate follow-up. Note: on Node 19+ the global HTTP agent keeps
  connections alive, and the adapters have tiny connection tables.

## Pi rollout checklist (2.0)

1. Back up off the Pi: `accessories/cachedAccessories.0EA3CB05C3A2`, `persist/`,
   `mitsubishi-comfort-local-creds.json`, `mitsubishi-comfort-mirror-state.json`.
2. Install a packed tarball; full Homebridge restart.
3. **Rebuild the skylight automation immediately** (open skylight → all units off). Until then the
   skylight doesn't turn the units off. Trigger it once and confirm from the log (local reads)
   that all five units actually went off, not just that commands were accepted.
4. Log: five "migrated" lines, no HAP characteristic warnings.
5. Home app per unit: power, Heat/Cool/Auto, thresholds, fan slider + Auto, no swing/Slats
   (fixed vanes), humidity only where a sensor exists.
6. Set 72°F → log shows 22.3 sent, Comfort app shows 72.
7. Every fan position on every unit, including the cloud-only front bedroom. Profiles report
   `numberOfFanSpeeds: 3`; confirm each position sticks. If not, honor `numberOfFanSpeeds`.
8. Fan change on an off unit leaves it off; fan-tile OFF refused; `Active` OFF stops a dry unit.
9. Mirror: HomeKit change follows in ~1s, wall change in ~15s; restart logs "baseline seeded"
   (no push); manual living-room change holds.
10. 24h soak: no mirror pushes without a real source change.

## Open

- Whether to contact ukaratay about the port or about converging the two plugins (owner).
