# Streaming + Local-Poll Resilience — Design & Pressure Test

**Date:** 2026-08-14
**Status:** Draft for review (no code changed)
**Trigger:** 2026-08-13 ~22:59 → 2026-08-14 10:24 the plugin silently froze on stale
state. HomeKit showed units "off" that were actually running. A child-bridge restart
fully recovered it. Investigation found **two independent failures**, only one of which
has a root cause; the other needs resilience.

---

## 1. What actually failed

### 1a. Local-poll wedge — ROOT CAUSED (real bug)
`local-api.ts:request()` races the `fetch` against a 6 s timer, but `fetch` resolves on
**headers**. The body read `await res.json()` (line 217) runs *after* the race and has
**no timeout and no abort** (`node-fetch` v3, no `signal:`). A unit that returns headers
then stalls the body makes `res.json()` hang forever → the per-serial `withLock` chain
(175-181) never settles → because `platform.ts:startLocalPolling` awaits each `getStatus`
**sequentially** (793-806), the whole loop wedges at that device and every 15 s tick piles
up behind the dead lock. Local polling dies for all units until the process restarts.
The loser `fetch` is also never aborted, leaking its socket.

Confidence it's a real bug: **high**. Confidence it's *the* Aug-13 cause: **medium** — the
diagnostic lines are `log.debug`, invisible without `-D` (0 hits in the whole log), so it
can't be confirmed from logs. See §5.

### 1b. Streaming zombie — RESILIENCE ONLY (no root cause)
The health check is socket-only: `isStreamingHealthy = socket.connected` (kumo-api.ts:1010-1017),
with a comment betting "socket.io fires disconnect if the connection is lost." A half-dead
socket breaks that bet: transport alive (engine.io pings, `ss` showed `lastrcv` ~6 s) while
the server-side **device_update** subscription silently stopped. `profile_update` kept
arriving (the ~15-min "Set temperature range" churn), which is why a naive "any socket data"
watchdog would be fooled. We do not know *why* the subscription died; the design recovers
from it, it does not prevent it.

### Why neither backed up the other
With `localControl` on, the accessory treats local as authoritative and **drops** streaming
updates while a local poll landed < 45 s ago (accessory.ts:717-724). So local poll is the
plugin's real eyes; streaming is the fallback. Aug 13 both eyes failed at once — local
wedged (1a) and streaming was a zombie (1b) — so nothing had a live view.

---

## 2. Fix #1 — Bound the local HTTP request (the actual bug fix)

**Change `local-api.ts`** `request()` and `probeIpForSerial()` to use an `AbortController`
that covers the **entire** request including the body read, mirroring the pattern already in
`kumo-api.ts:898-909`.

```ts
async request(serial, body) {
  const creds = this.creds.get(serial);
  if (!creds) return null;
  return this.withLock(serial, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);   // covers headers AND body
    try {
      const res = await fetch(`http://${creds.ip}/api?m=${token}`, {
        method: 'PUT', headers: {...}, body,
        signal: controller.signal,          // <-- was missing
      });
      const json = await res.json().catch(() => null);   // now abortable: signal tears down the body stream
      ...
    } catch (err) {
      // AbortError lands here → treated as "no data" (null), poll continues
      if (this.debugMode) this.log.info(`[LOCAL] ${serial} @ ${creds.ip}: request failed (${err.message})`);
      return null;
    } finally {
      clearTimeout(timer);               // no leaked timers / late aborts
    }
  });
}
```

- Drop the `Promise.race`-against-a-timer; the signal is strictly better (covers the body,
  and actually cancels the socket so it can't leak).
- `withLock` is unchanged — it already swallows errors so one failure never blocks the next.
- Same treatment for `probeIpForSerial` (line 294-301, same unbounded `res.json()` at 301).

**Net:** `request()` now always settles in ≤ `timeoutMs`. The sequential poll loop can no
longer wedge, and the socket leak is gone.

---

## 3. Fix #2 — Streaming liveness (active probe + auto-recover) + coarse backstop

Two layers. The probe is the surgical streaming detector; the backstop is the catch-all that
would have auto-recovered Aug 13 even with zero diagnosis.

### 3a. Active liveness probe (in `kumo-api.ts`, owns the socket)
- Track `lastDeviceUpdateInboundTs`, bumped in the **`device_update`** socket handler only
  (NOT `profile_update`/`acoil_update` — those flowed during the zombie).
- Every `PROBE_INTERVAL` (**180 s**), if `isStreamingConnected() && !isReconnecting`, emit
  `force_adapter_request(serial, 'iuStatus')` for one device (rotate through the list). This
  forces a `device_update` even when nothing changed — so a healthy-but-quiet stream still
  answers (this is the whole reason the deprecated `streamingStaleThreshold` was unsafe and
  this isn't).
- If no `device_update` arrives from **any** device within `PROBE_TIMEOUT` (**20 s**), count
  a miss. After `MAX_MISSES` (**2** consecutive, ~6 min worst-case), the subscription is dead
  → call `reconnectStreaming()`.
- Probing the exact pathway that died (`device_update` delivery) catches both zombie
  sub-types: "server ignores all emits" and "server answers `device_status_v2` but dropped
  `device_update`." A `device_status_v2` probe would miss the second; `iuStatus`→`device_update`
  does not.
- **Enhancement to `reconnectStreaming()`:** on a *watchdog-initiated* reconnect, also emit
  `force_adapter_request(iuStatus)` after connect (currently gated off for routine reconnects,
  672) so state reseeds within seconds instead of waiting for the next real change.
- **Cooldown:** min **300 s** between probe-initiated reconnects; `RECOVERY_IN_PROGRESS`
  guard so probe + token-refresh reconnect can't double-fire.

### 3b. Coarse freshness backstop (in `platform.ts`, sees everything)
- `lastLocalPollSuccessTs` — bumped when any device's local `getStatus` returns non-null.
- `lastAppliedUpdateTs` — bumped when any accessory applies a real update (any source).
- Watchdog interval **60 s**:
  - `localControl` on and `now - lastLocalPollSuccessTs > max(45s, 3×localPollInterval)` →
    the local loop is wedged → `clearInterval(localPollTimer)` + `startLocalPolling()` (and
    a visible log line). Redundant with Fix #1, kept as defense-in-depth for unknown wedges.
  - `now - lastAppliedUpdateTs > GLOBAL_STALE_MS` (**600 s**) → full recovery:
    `reconnectStreaming()` + local-loop restart. This is the single check that would have
    auto-fixed Aug 13 regardless of cause.
- Safe in both modes: `localControl` on → local poll heartbeats every 15 s, so 10 min of
  silence is a true anomaly. Cloud-only → the §3a probe forces a `device_update` every 3 min,
  so 10 min of silence = ≥3 missed probes = genuinely dead. No quiet-house false trip.

### API-cost / rate-limit (see also the earlier analysis)
- Probe = one socket **emit** per 3 min. Not a REST call; cannot touch the v3 REST rate limit.
- Recovery = `reconnectStreaming()` = socket teardown/reconnect, **no `login()`** unless the
  token is independently stale. `login()` already has 429 backoff + min-interval + refresh
  jitter (kumo-api.ts:119-167, 231-235). Cooldown caps a persistent outage at ~1 recovery per
  5 min. Steady-state added cloud load: **zero**.

---

## 4. Fix #3 — Visibility (make the next incident diagnosable)

The whole investigation was blind because local-poll failures log at `log.debug` and HB isn't
run with `-D`. Promote the operator-relevant lines to the existing debug-gated info pattern
(`if (this.debugMode) this.log.info(...)`, which IS visible because `kumoConfig.debug: true`):
- local request timeout / failure (local-api.ts 214, 222, 226) — **on transition only**
  (first failure per device, and on recovery) to avoid a 15 s spam loop for a chronically
  unreachable unit (e.g. front bedroom).
- `[STREAM] liveness probe missed (n/2)` and every watchdog/probe recovery action.
- `[LOCAL] poll loop restarted by watchdog`.
Pass `debugMode` into `LocalKumoClient` (constructor already takes a logger; add the flag).

---

## 5. Pressure test

### Failure-mode coverage

| Scenario | Detected by | Recovered by | Verdict |
|---|---|---|---|
| Local body-read hang (the Aug-13 local wedge) | — (prevented) | Fix #1 (request always settles) | **Prevented at source** |
| Local loop wedges for any *other* reason | #3b (`lastLocalPollSuccessTs`) | #3b restart loop | Caught in ≤ ~45 s |
| Streaming zombie (device_update subscription dead, socket up) | #3a probe (no device_update to forced iuStatus) | #3a `reconnectStreaming` | Caught in ≤ ~6 min |
| Streaming zombie *and* local wedge (the real Aug 13) | #3a probe **and** #3b global | both recover independently | **Auto-recovers, no human** |
| Total cloud/API outage | #3a/#3b (silence) | retries w/ backoff; can't fix an outage — correct | Degrades safely, logs it |
| Clean socket drop | existing `disconnect` handler → degraded polling | existing | unchanged |

### Edge cases / false-positive analysis
- **Quiet house, cloud-only:** probe forces a `device_update` every 3 min → no false reconnect. ✓
- **`profile_update` churn (the zombie signature):** excluded from the liveness signal, so it
  cannot mask a dead stream. ✓ (This is the trap a naive watchdog falls into.)
- **One chronically-silent device** (front bedroom, cloud-cred issue): probe rotates devices
  and passes on a `device_update` from **any** device; a single dead unit can't force a loop.
  Local backstop keys on "any device succeeded," so one unreachable unit doesn't trip it. ✓
- **Token-refresh reconnect (every 15 min):** probe gated on `!isReconnecting`; recovery
  cooldown + `RECOVERY_IN_PROGRESS` guard prevent double-reconnect. ✓
- **Probe device_update dropped by the accessory's local-authoritative guard:** liveness is
  tracked in kumo-api (socket layer) *before* the accessory guards, so it counts even when the
  accessory correctly drops it. ✓ (Testing the socket pathway, not accessory application.)
- **Abort during body read:** `AbortError` → caught → `null` → poll continues. Abort tears
  down the socket → no leak. ✓
- **New timers on shutdown:** register probe/watchdog timers in the existing teardown that
  clears `localPollTimer` (platform.ts:155) — no leak across child-bridge restarts. ✓
- **No new command path:** watchdog only reconnects / restarts polling; never sends device
  commands. Mirror/setpoint logic untouched; normal updates resume post-recovery and mirror
  works. ✓

### Residual risks (honest gaps)
1. **`node-fetch` v3 abort-during-body-read** — I'm ~95% sure `controller.abort()` rejects an
   in-progress `res.json()` (it tears down the response body stream). **Verify at
   implementation** with a 5-line test against a server that sends headers then hangs. If it
   somehow doesn't, fall back to wrapping `res.json()` in its own `Promise.race` timer too.
2. **`reconnectStreaming()` reliably clears a *zombie*** — the manual fix was a full *process*
   restart; the watchdog does a *socket* teardown+reconnect. High confidence it's equivalent
   (a new socket = a new server-side subscription, same as the 15-min token-refresh reconnect
   that works daily), but not 100%. Mitigation: #3b escalates, and if a socket reconnect can't
   restore data, the plugin is no worse off than today (it would still be reconnecting).
3. **Streaming zombie is recovered, not prevented** — root cause of the subscription death is
   unknown. Acceptable (recovery is the goal), but stated plainly. Fix #3's visibility is what
   lets us root-cause it if it recurs.

---

## 6. Rollout & validation

1. **Ship Fix #1 + Fix #3 first** — the concrete bug fix + visibility. Low risk, high
   confidence, matches an existing in-repo pattern.
2. **Then Fix #2** (probe + backstop) as the broader safeguard.
3. **Validate on the Pi** (not just "reads fine"):
   - Fix #1: point a unit's IP at a stub that sends headers then hangs; confirm the poll loop
     keeps cycling other units and the request settles at `timeoutMs` (watch the now-visible
     `[LOCAL] ... request failed` line). Confirm no fd/socket growth over an hour (`ls
     /proc/<pid>/fd | wc -l`).
   - Fix #2: after a healthy connect, block the device_update path (or just wait for a natural
     quiet period) and confirm the probe keeps the stream marked healthy without reconnecting;
     then simulate a dead subscription and confirm one reconnect fires within ~6 min, with the
     cooldown preventing a storm.
   - Confirm normal-state cloud call volume is unchanged (token refresh every ~15 min only).
