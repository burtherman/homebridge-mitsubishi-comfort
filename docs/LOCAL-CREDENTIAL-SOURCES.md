# Local credentials: where they come from, and what broke

**Last verified: 2026-09-12** (re-verify before trusting any of this; Mitsubishi changes
the cloud without notice). Upstream reports added 2026-09-27.

Local LAN control needs two secrets per device:

| Secret | Shape | Used for |
|--------|-------|----------|
| `password` | base64, 40 chars (30 raw bytes) | hashed into the request token |
| `cryptoSerial` | hex, 18 chars (9 bytes) | shuffled slice goes into the token |

Both feed `computeLocalToken()` in `src/local-api.ts`. Get either wrong and the adapter
answers `HTTP 200 {"_api_error":"device_authentication_error"}` — a 200, not an auth
status code, so check the body.

## The three sources, and their state today

### 1. `adapter_update` Socket.IO event — **dead since 2026-08-01**

Historically the only source of `password`. Fired in response to
`force_adapter_request(serial, 'adapterStatus')`, after an account-level
`subscribe('', userId)`.

As of **2026-08-01 03:03 UTC** the event still fires but **no longer carries
`password`**. Current payload:

```
deviceSerial, firmwareVersion, roomTempDisplayOffset, routerSsid, routerRssi,
minSetpoint, maxSetpoint, minSetPoint, maxSetPoint, lastUpdated, date
```

`firmwareVersion` there reads `"00.00.00"` while `/devices/{serial}/status` reports the
real version for the same unit at the same moment. Don't use the socket copy.

### 2. `GET /v3/devices/{serial}/status` — **no longer returns `cryptoSerial`**

This endpoint was the documented `cryptoSerial` source (still is, in pykumo's header
comment). It stopped returning the field in the same window. Verified 2026-09-12 across
all five of our units — the complete key set is now:

```
firmwareVersion, roomTempDisplayOffset, routerSsid, routerRssi,
minSetPoint, maxSetPoint, lastUpdated, mac
```

`getDeviceCryptoSerial()` in `kumo-api.ts` therefore returns nothing. We survive on the
credential store, and on source 3.

### 3. Legacy v2 (`https://geo-c.kumocloud.com/login`) — **still works, for old records only**

`POST /login` with `{ username, password, appVersion: '2.2.0' }` returns a nested tree
containing per-serial objects with **both** `password` and `cryptoSerial`. Walk the tree
and collect any object having both fields, keyed by its parent key (the serial). That's
`fetchLegacyCredentials()` in `kumo-api.ts`.

**Verified live 2026-09-12:** credentials pulled fresh from v2 (cache bypassed entirely)
authenticated against three units on the LAN. For the four units where we hold a
known-good cached credential, the v2 values are **byte-identical** — password and
cryptoSerial both.

This is the only live credential source left.

**It only covers units registered before the Comfort switchover, as they were then.** v2
serves a frozen copy of the old Kumo account data, and nothing written since reaches it:

- **Newer accounts get nothing.** For an account with no pre-switchover record, v2
  answers `200 null` to a wrong password and HTTP 500 to the correct one (taolong75,
  pykumo #78, 2026-08-22). The 500 is not an auth failure. joshuat hit the same 500 on a
  very new account (pykumo #78, 2026-09-27).
- **Changes after the switchover don't show up.** We removed the front bedroom in the
  Comfort app and added it back on 2026-08-05. v3 created a new adapter record for it
  (same serial, new creation date), and v2 kept returning the same password and
  cryptoSerial as before. dlarrick, pykumo's maintainer, says v2 doesn't work "for new
  users, and not for anything that has changed since Mitsubishi switched over to Comfort"
  ([hass-kumo #230](https://github.com/dlarrick/hass-kumo/issues/230#issuecomment-5649238466),
  2026-09-12). He's also seen v2 serve stale IP addresses (pykumo #78, 2026-08-20).

v2 has records for our units because all five were registered in the old Kumo app before
the switchover. **A unit added to this account from now on gets no local credential from any
source we know of.** Don't remove and re-add a working unit to test this either: if that
rotates the adapter's key (suspected, not shown), v2 will keep serving the old one.

## Timeline

| Date | Event |
|------|-------|
| 2026-05-19 | hass-kumo #220 opened — v3 returns credentials for only *some* units on multi-unit accounts |
| 2026-07-28 | Last confirmed-working day for v3 credential retrieval (ukaratay, pykumo #78) |
| **2026-07-30 02:12 UTC** | **Our credential store was captured — 4 of 5 units** |
| 2026-07-31 | pykumo #78 and hass-kumo #230 opened |
| 2026-08-01 03:03 UTC | v3 confirmed no longer returning either secret, any endpoint, any `X-App-Version` |
| 2026-08-05 | Front bedroom removed and re-added in the Comfort app; v2 keeps serving the same credential |
| 2026-08-22 | taolong75 (pykumo #78): v2 returns HTTP 500 for accounts with no pre-switchover record |
| 2026-09-12 | We verify legacy v2 still serves working credentials and post it to pykumo #78 and hass-kumo #230 |
| 2026-09-12 | dlarrick replies: v2 doesn't cover new users or anything changed since the switchover |
| 2026-09-27 | joshuat (pykumo #78): v2 500 on a new account, asks whether moving units to an older account would help. [Our reply](https://github.com/dlarrick/pykumo/issues/78#issuecomment-5859953595): our Aug 5 re-add didn't change v2, so probably not |

Our store predates the shutoff by roughly 25 hours. **Those four credentials are
effectively irreplaceable from v3.** Both recoveries reported in hass-kumo #230 came from
restoring old cache files out of backups.

## Operational consequence: protect the store

`mitsubishi-comfort-local-creds.json` in the Homebridge storage dir is not a cache you
can rebuild. If it's lost and legacy v2 ever goes the way of v3, local control is gone
permanently for every unit. Back it up off-box. It holds secrets — treat it accordingly.

## The partial-coverage bug (why the front bedroom has never worked)

Separate from the August shutoff, and older. On multi-unit accounts v3 hands back
credentials for some units and not others. hass-kumo #220 (opened 2026-05-19) reports 1
of 5; a second reporter in the same thread sees 1 of 2. Deleting and re-adding the HA
integration doesn't change which units are covered, and neither does logging out and back
into the Comfort app.

We first filed our front bedroom `0Y34P008Q100142F` as an instance of this. It has never
produced a password via the socket — it was already missing when the store was built on
2026-07-30 at 4 of 5. Its legacy v2 entry exists but does **not** authenticate, so v2's
copy for that unit is stale or wrong in a way that we can't correct from outside. Its
cryptoSerial is correct (it matches a December 2025 mitmproxy capture), so the password is
the stale half.

The frozen-v2 finding above gives a simpler explanation than #220: if this adapter's key
changed after the switchover, v2 would still hand out the old one. As far as we remember
it's the only unit that was ever disconnected and reconnected in the Comfort app, which
fits. We don't know when that first happened, though, so this is unproven.

**Things that have been tried and did not fix it:**

- Wi-Fi reconnect (the adapter is reachable at `192.168.50.142` and answers HTTP; it just
  rejects the key)
- Adapter reset button, then reconnect
- Power cycle
- Child bridge restart, which re-runs the full nudge sequence — all 3 retry attempts fail
  identically
- Removing it in the Comfort app and adding it back (2026-08-05). v3 made a new adapter
  record; v2 returned the same credential as before

**Things reported upstream as not fixing the equivalent problem:**

- Power-cycling all units (ukaratay, pykumo #78)
- A brand-new Comfort registration with no cache to fall back on — still no credential
  issued (aphollis, hass-kumo #230, 2026-08-30). This is the closest available test of the
  "just re-pair it in the app" theory, and it comes back negative.

The plugin's log line used to say "re-pair the unit in the app to refresh its local key".
That was a guess, not a finding, and it's gone: the warning in
`platform.ts:reportUnresolved` now says there's no known way to refresh the key.

## Verification recipes

Re-check whether v3 has started serving secrets again:

```js
// after a v3 login, with Authorization: Bearer <access> and X-App-Version
const st = await (await fetch(`${API_BASE_URL}/devices/${serial}/status`, { headers })).json();
Object.keys(st);           // cryptoSerial present again?
```

Check whether a credential actually authenticates, rather than guessing from cloud state:

```js
const token = computeLocalToken(password, cryptoSerial, STATUS_READ_BODY);
const r = await fetch(`http://${ip}/api?m=${token}`, { method: 'PUT', body: STATUS_READ_BODY, ... });
// { r: { indoorUnit: ... } }          -> credential good
// { _api_error: 'device_authentication_error' } -> wrong password or cryptoSerial
// { _api_error: ... } anything else   -> a Kumo adapter, but not this serial
```

**Don't** infer credential health from `/sites/{id}/zones` or from `adapter.connected` —
both lie. See the reachability notes in `CLAUDE.md`.

## Dead end: the Comfort app's password-free ATSHA204 path (tested 2026-09-12)

Don't re-run this — it's been tested with a proper control and it does not work for local
control. Recorded here so the reasoning isn't lost.

The Comfort app has a second local-auth construction, recovered from the
[KTibow/comfort-decompilation](https://github.com/KTibow/comfort-decompilation) dump
(`calculateMacHash` / `Atsha204ServicesImpl`). It is our exact 88-byte ATSHA204 token with
two fields changed, and **no per-device password**:

| Field | Our HTTP path | App path |
|-------|---------------|----------|
| `buf[0:32]` secret | `W_PARAM` `44c73283…` | `MEUS_ADAPTER_COMMUNICATION_KEY` `9f549fc9e4fe0d82ee66c083aa25b8f94d920c64fdd5e60574fc053dbe5776fd` |
| `buf[32:64]` challenge | `SHA256(password ‖ body)` | `SHA256(body)` — no password |
| slot `buf[66]` | 0 | `MEUS_ADAPTER_CRYPTO_SLOT` = 0 |

The hope was that an adapter honoring this global slot-0 key on its local HTTP endpoint
would sidestep the missing/broken per-device password entirely.

**Result — rejected.** Built the app-style token and did a read-only status PUT to
`/api?m=`, sweeping slots [0,1,2,3,8,15], against both the front bedroom (`.142`, the
broken unit) **and the kitchen (`.15`) as a control** — the kitchen authenticates fine on
the normal password path. Every probe on **both** units returned
`HTTP 200 {"_api_error":"device_authentication_error"}`. The control failing is the
decisive part: the local HTTP endpoint does not accept the slot-0 global key from anyone.

**Why it can't work, and why chasing it further is pointless:** the app doesn't send this
over local HTTP at all. It sends it over `WEB_SOCKET_PROXY_URL = ws://3.80.103.210:8080`
(function_53602.js) — an AWS cloud proxy — as `cryptoSerial\ntoken\nbody`. So the app's
password-free path is a **cloud relay** with end-to-end device auth, not a local channel.
Reproducing it would at best duplicate the cloud `send-command` control we already have.
The UDP broadcast discovery (`58880`, models `MAC888`/`PAC-WHS01WF-E`/`MEUS-ADAPTER-0`) and
the `blewifi.local` origin header are the BLE-WiFi commissioning flow, not steady-state
control.

**Confirmed independently along the way:** the adapters are ATSHA204-based (our token
layout matches the chip's MAC command byte-for-byte, and `cryptoSerial` matches the part's
serial format), which is consistent with the password being random per-device secret
material provisioned at manufacture — i.e. not derivable, only retrievable from the cloud.
That matches the failed brute-force in pykumo #57.

## Reported upstream

We posted the v2 endpoint to pykumo #78 and hass-kumo #230 on 2026-09-12, answering
jonwales's 2026-08-22 question about how this plugin still works. dlarrick replied the same
day that v2 doesn't help new users or anything changed since the switchover. That's
correct, and it's written up under source 3 above. On 2026-09-27 we replied to joshuat's
idea of moving units to an older account (see the timeline).

Worth checking back: dlarrick said he's adding indoor units to his own account this fall
and will confirm the new-unit behavior first-hand.

## References

- [pykumo #78](https://github.com/dlarrick/pykumo/issues/78) — V3 no longer provides password or cryptoSerial (open)
- [hass-kumo #220](https://github.com/dlarrick/hass-kumo/issues/220) — V3 returns credentials for only 1 of 5 units (open)
- [hass-kumo #230](https://github.com/dlarrick/hass-kumo/issues/230) — can't regenerate kumo_cache.json (open)
- [pykumo #57](https://github.com/dlarrick/pykumo/issues/57) — is the password derivable? Brute-force against serial/MAC/cryptoSerial/SSID failed; the adapters appear to use an ATSHA204 crypto chip, and `cryptoSerial` matches that part's serial format
- [pykumo `py_kumo_cloud_account_v3.py`](https://github.com/dlarrick/pykumo/blob/master/pykumo/py_kumo_cloud_account_v3.py) — reference implementation of the socket sequence, identical to ours
