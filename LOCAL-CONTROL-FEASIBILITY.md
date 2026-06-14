# Local LAN Control — Feasibility Findings

**Date:** 2026-06-14
**Question:** Can this plugin move from Kumo *Cloud* control to direct *local LAN* control of the indoor units, like the official Home Assistant `mitsubishi_comfort` integration does?

**Bottom line:** Yes, and it's a good fit. The local protocol is fully reverse-engineered in [dlarrick/pykumo](https://github.com/dlarrick/pykumo) and ports to Node's built-in `crypto` in a few lines. Two of the three secrets you need we **already see**: `cryptoSerial` (already fetched from `GET /devices/{serial}/status`, currently unused) and the per-unit local `password` (already arrives in the `adapter_update` Socket.IO event we already subscribe to — and currently strip before logging). The one genuinely new requirement is each unit's **LAN IP**, which the cloud does not hand out.

Recommended shape: **hybrid** — keep cloud login + Socket.IO for discovery and credentials, add a local transport for control + status. This mirrors the official HA integration (`iot_class: local_polling`, "Kumo Cloud only for initial device discovery and credential retrieval").

---

## A. Local protocol (per pykumo source)

### Transport
- **HTTP PUT** (plain HTTP, no TLS) to `http://<unit-ip>/api?m=<token>`.
- Headers: `Accept: application/json, text/plain, */*`, `Content-Type: application/json`.
- Body is the command JSON as UTF-8. **Both reads and writes are PUT** — a status read is a PUT whose body has empty leaf objects; the unit echoes populated values back under `"r"`.
- Source: `pykumo/py_kumo_base.py` `_request()`.

### Request-signing / security token (per `pykumo/py_kumo_base.py` `_token()` + `pykumo/const.py`)

Constants:
```
W_PARAM = hex "44c73283b498d432ff25f5c8e06a016aef931e68f0a00ea710e36e6338fb22db"  (32 bytes)
S_PARAM = 0
```

Per-device material: `password` is a **base64** string (decode to bytes); `cryptoSerial` is a **hex** string (decode to bytes).

Algorithm:
1. `dataHash = SHA256( base64Decode(password) ‖ bodyBytes )`
2. Build an 88-byte buffer:
   - `[0..32)`  = `W_PARAM`
   - `[32..64)` = `dataHash` (all 32 bytes)
   - `[64..66)` = `0x08 0x40`
   - `[66]`     = `S_PARAM` (0x00); `[67..79)` stays zero
   - `[79]`     = `cryptoSerial[8]`
   - `[80..84)` = `cryptoSerial[4..8)`
   - `[84..88)` = `cryptoSerial[0..4)`
3. `token = SHA256(buffer).hex()` → URL `?m=<token>`.

Note the byte-shuffle uses only `cryptoSerial` bytes 0–8, so the decoded `cryptoSerial` must be ≥ 9 bytes (≥ 18 hex chars). Node port is ~15 lines with `crypto.createHash('sha256')`, `Buffer.from(password,'base64')`, `Buffer.from(cryptoSerial,'hex')`, `Buffer.alloc(88)`.

### Command / status JSON (per `pykumo/py_kumo.py`)
All bodies are `{"c":{"indoorUnit":{"status":{ ... }}}}`:

| Action | Inner `status` object |
|---|---|
| Set mode | `{"mode":"<off\|cool\|dry\|heat\|vent\|auto>"}` |
| Heat setpoint | `{"spHeat":<°C>}` |
| Cool setpoint | `{"spCool":<°C>}` |
| Fan speed | `{"fanSpeed":"<superQuiet\|quiet\|low\|powerful\|superPowerful\|auto>"}` |
| Vane | `{"vaneDir":"<horizontal\|midhorizontal\|midpoint\|midvertical\|vertical\|auto\|swing>"}` |
| Power | no separate field — `mode:"off"` powers down, any active mode powers on |

Status read sends empty leaves (`{"c":{"indoorUnit":{"status":{}}}}`) and the unit replies under `r.indoorUnit.status` with `mode, standby, spHeat, spCool, roomTemp, fanSpeed, vaneDir, filterDirty, defrost` — i.e. the same data we get today from the cloud `device_update`. Local field names differ: `mode` (not `operationMode`), `vaneDir` (not `airDirection`).

## B. cryptoSerial — is our already-fetched field the local key? **Yes** (per source)

pykumo's v3 cloud module (`py_kumo_cloud_account_v3.py`) reads the crypto key from the **same endpoint we already call** — `GET /v3/devices/{serial}/status` → `status["cryptoSerial"]` — then hex-decodes it and feeds it straight into `_token()`. So the `cryptoSerial` we fetch and currently ignore *is* the local signing key. **Open live check:** confirm our captured value is ≥ 18 hex chars.

## C. Credential + IP retrieval

Three per-unit pieces, three sources:
1. **`cryptoSerial`** — REST `GET /v3/devices/{serial}/status`. *We already fetch this.*
2. **Local `password`** — Socket.IO, **not** REST. pykumo v3 forces an `adapter_update` (`force_adapter_request(serial, 'adapterStatus')`) and reads `payload[1].password`. **This is the exact flow we already run** — our CLAUDE.md documents the `force_adapter_request(..., 'adapterStatus')` emit and notes the `adapter_update` payload "contains password, strip before logging." We already receive it and throw it away; capturing it is a one-line change. (Encoding: confirmed base64 on pykumo's v2 path; the v3 websocket-password→base64 assumption is **not 100% verified in source** — resolve with one live capture before trusting it.)
3. **Local IP** — **the real gap.** No cloud field returns the LAN IP in the code paths read. pykumo gets candidate IPs from HA's DHCP discovery and probes each (authenticated request, match by serial). The official HA integration uses DHCP discovery + optional manual IP. The MAC *is* available (`adapter.macAddress`), but MAC→IP needs on-LAN discovery (mDNS / ARP / DHCP leases) or a user-supplied static IP.

## D. Node port feasibility, risks, effort

**Signing in Node:** unambiguously yes, standard `crypto` primitives, zero new deps. Local PUT is plain `http` to `http://<ip>/api?m=<token>` — client must not force HTTPS.

**Risks / unknowns:**
1. **IP discovery is the only hard part.** No cloud field gives the LAN IP. v1 should require a user-configured static-IP-per-serial; auto-discovery (mDNS/ARP under a non-root Homebridge service) is a separable, riskier follow-up.
2. **Same-LAN requirement.** Homebridge host and the units must share a routable subnet; VLAN-segmented IoT networks break this. (Our units and the Pi are on the same LAN today.)
3. **Adapter reliability / firmware drift.** hass-kumo notes a post-2023 adapter-reliability regression (suspected memory leak, occasional power-cycle needed). Local control surfaces adapter flakes the cloud used to mask — keep degraded-mode polling as the safety net.
4. **v3 password encoding** — verify base64 with one live capture (see B/C).
5. Plain HTTP + token-only auth on the LAN; documented design, low concern.
6. Local `/api` protocol has been stable for years; low churn.

**Effort (hybrid, manual-IP v1):** ~3 focused days — local transport + token port + JSON mapping (~1–1.5d), capture/store local password + wire cryptoSerial (~0.5d), manual static-IP config in `config.schema.json` + per-device local-vs-cloud selection (~0.5d), live verification on the Pi (~0.5–1d). Auto IP discovery: +2–4d, defer.

## E. Recommendation

Pursue it as a **hybrid with manual IP first**. Sequence:

1. **Spike the signing first** (retires the two biggest uncertainties before any refactor): on the Pi, capture one real `adapter_update` (local `password`) + the `cryptoSerial` for one unit, port `_token()` to Node, do one signed `PUT http://<ip>/api?m=<token>` with a status-read body, confirm a `200` + `r.indoorUnit.status`.
2. **Ship hybrid + manual IP.** Cloud stays the discovery/credential source and fallback transport; local becomes primary control/status when a per-serial IP is configured. Gate per-device, fall back to cloud when local is unreachable.
3. **Defer auto IP discovery.**

The one real gating constraint is operational, not cryptographic: units and the Homebridge host must share a routable LAN.

---

### Sources
- [dlarrick/pykumo](https://github.com/dlarrick/pykumo) — `py_kumo_base.py` (`_token`, `_request`), `py_kumo.py` (commands), `const.py` (`W_PARAM`/`S_PARAM`), `py_kumo_cloud_account_v3.py` (v3 cryptoSerial + adapter_update password), `py_kumo_cloud_account.py` (v2 base64/hex), `py_kumo_discovery.py` (IP from upstream DHCP).
- [Mitsubishi Comfort — Home Assistant](https://www.home-assistant.io/integrations/mitsubishi_comfort/) (hybrid model, `local_polling`, DHCP discovery).
- [dlarrick/hass-kumo](https://github.com/dlarrick/hass-kumo) (same-LAN requirement, IP-discovery sources, 2023 adapter-reliability caveat).

### Open items to verify live (need one real capture; not yet done)
- [ ] `cryptoSerial` decoded length ≥ 9 bytes.
- [ ] v3 `adapter_update.password` is base64 (then a signed local PUT returns 200).
- [ ] A unit's LAN IP is reachable from the Pi and responds on `/api`.
