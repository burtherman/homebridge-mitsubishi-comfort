import { createHash } from 'crypto';
import fetch, { RequestInit } from 'node-fetch';
import { Logger } from 'homebridge';
import { Commands, DeviceStatus } from './settings';

/**
 * Local LAN control of Mitsubishi Kumo adapters.
 *
 * The indoor-unit WiFi adapter exposes a local HTTP API at
 * `PUT http://<ip>/api?m=<token>` with a JSON body `{"c":{"indoorUnit":{"status":{...}}}}`.
 * Both reads and writes are PUTs — a status read sends empty leaf objects and the
 * unit echoes the populated values back under `"r"`.
 *
 * The request is authenticated with a token derived from two per-device secrets:
 *  - `password`     — base64, from the cloud `adapter_update` Socket.IO event
 *  - `cryptoSerial` — hex, from the cloud `GET /devices/{serial}/status`
 *
 * The token algorithm is a port of dlarrick/pykumo's `_token()` (verified
 * byte-for-byte against nikolairahimi/mitsubishi-comfort, the library behind
 * Home Assistant's official `mitsubishi_comfort` integration) and live-confirmed
 * against real hardware: a signed status read returned `200` + `r.indoorUnit.status`.
 *
 * Local-vs-cloud differences worth remembering:
 *  - Local fields are `mode` (not `operationMode`) and `vaneDir` (not `airDirection`).
 *  - There is NO `power` field locally — `mode:"off"` powers down, any active mode powers on.
 *  - `filterDirty` / `defrost` / `standby` come straight from the local status.
 *  - Humidity is NOT in the status read (it lives in a separate sensors/MHK2 query and
 *    only exists on sensor-equipped units) — handled by the cloud path for now.
 */

/** Fixed 32-byte constant baked into the adapter's token scheme (pykumo `W_PARAM`). */
const W_PARAM = Buffer.from(
  '44c73283b498d432ff25f5c8e06a016aef931e68f0a00ea710e36e6338fb22db',
  'hex',
);

/** The query body for a full status read (empty leaves = "report everything"). */
export const STATUS_READ_BODY = Buffer.from('{"c":{"indoorUnit":{"status":{}}}}', 'utf8');

export interface LocalDeviceCreds {
  ip: string;
  password: string; // base64
  cryptoSerial: string; // hex, >= 9 bytes
}

/** Round to 0.1°C — strips float noise; the units honor 0.1 granularity (verified). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compute the URL security token for a given request body.
 * Port of pykumo `_token()`: two SHA-256s over an 88-byte buffer assembled from
 * W_PARAM, sha256(password ‖ body), the constant `0x0840`, S_PARAM (0), and a
 * shuffled slice of the cryptoSerial (bytes [8], [4:8), [0:4)).
 */
export function computeLocalToken(passwordB64: string, cryptoSerialHex: string, body: Buffer): string {
  const password = Buffer.from(passwordB64, 'base64');
  const cryptoSerial = Buffer.from(cryptoSerialHex, 'hex');
  if (cryptoSerial.length < 9) {
    throw new Error(`cryptoSerial too short (${cryptoSerial.length} bytes, need >= 9)`);
  }

  const dataHash = createHash('sha256').update(Buffer.concat([password, body])).digest();

  const buf = Buffer.alloc(88);
  W_PARAM.copy(buf, 0); // [0:32)
  dataHash.copy(buf, 32); // [32:64)
  buf[64] = 0x08;
  buf[65] = 0x40; // [64:66)
  buf[66] = 0x00; // S_PARAM; [67:79) stay zero
  buf[79] = cryptoSerial[8];
  cryptoSerial.copy(buf, 80, 4, 8); // [80:84) = cryptoSerial[4:8)
  cryptoSerial.copy(buf, 84, 0, 4); // [84:88) = cryptoSerial[0:4)

  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build the local command body for a set of our cloud-shaped Commands.
 * Maps `operationMode` → `mode`, rounds setpoints to 0.1°C, and DROPS `power`
 * (local control expresses on/off purely through `mode`).
 */
export function buildLocalCommandBody(commands: Commands): Buffer {
  const status: Record<string, unknown> = {};

  if (commands.operationMode !== undefined) {
    status.mode = commands.operationMode; // off/heat/cool/auto/vent/dry — same strings locally
  }
  if (commands.spHeat !== undefined) {
    status.spHeat = round1(commands.spHeat);
  }
  if (commands.spCool !== undefined) {
    status.spCool = round1(commands.spCool);
  }
  if (commands.fanSpeedRaw !== undefined) {
    // Mirror path: the source's raw adapter fan-speed string (e.g. 'quiet',
    // 'powerful') is already in the local vocabulary — write it verbatim rather
    // than collapsing it through the coarse enum (which would mis-map, since
    // 'low'/'auto' overlap between the two vocabularies with different meanings).
    status.fanSpeed = commands.fanSpeedRaw;
  } else if (commands.fanSpeed !== undefined) {
    status.fanSpeed = mapFanSpeedToLocal(commands.fanSpeed);
  }
  // Note: commands.power is intentionally ignored — `mode` carries on/off locally.

  return Buffer.from(JSON.stringify({ c: { indoorUnit: { status } } }), 'utf8');
}

/** Our coarse cloud fan-speed vocabulary → the adapter's local fan-speed strings. */
function mapFanSpeedToLocal(speed: NonNullable<Commands['fanSpeed']>): string {
  switch (speed) {
    case 'auto': return 'auto';
    case 'low': return 'quiet';
    case 'medium': return 'low';
    case 'high': return 'powerful';
    default: return 'auto';
  }
}

/**
 * Map a local `r.indoorUnit.status` object onto our DeviceStatus shape.
 * Returns the fields the local API provides; humidity is omitted (cloud-only).
 */
export function mapLocalStatus(local: Record<string, unknown>): Partial<DeviceStatus> {
  const mode = typeof local.mode === 'string' ? local.mode : 'off';
  return {
    operationMode: mode,
    power: mode === 'off' ? 0 : 1,
    roomTemp: local.roomTemp as number,
    spHeat: local.spHeat as number,
    spCool: local.spCool as number,
    spAuto: null, // these units have no spAuto; auto uses the spHeat/spCool band
    fanSpeed: (local.fanSpeed as string) ?? 'auto',
    airDirection: (local.vaneDir as string) ?? 'auto', // local `vaneDir` == cloud `airDirection`
    filterDirty: local.filterDirty === true,
    defrost: local.defrost === true,
    standby: local.standby === true,
    connected: true, // a successful local read means the unit is reachable
  };
}

/**
 * Per-device local HTTP client. Serializes requests per unit (the adapter
 * tolerates only ~one concurrent local connection — pykumo locks for this reason;
 * the HA library dropped the lock, which we don't repeat) and uses a forgiving
 * timeout (the reference's 1.2s connect timeout flaps on busy WiFi).
 */
export class LocalKumoClient {
  private readonly creds = new Map<string, LocalDeviceCreds>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Serials currently in a failed-read state — drives transition-only logging. */
  private readonly failingSerials = new Set<string>();

  constructor(
    private readonly log: Logger,
    private readonly timeoutMs: number = 6000,
    private readonly debugMode: boolean = false,
  ) {}

  /**
   * Log a local-read failure at a VISIBLE level, but only on the transition into
   * failure (and once on recovery), so a chronically unreachable unit can't spam a
   * line every poll cycle. `debugMode` (the plugin's own `debug` flag) is visible in
   * the normal log; plain `log.debug` is not unless Homebridge runs with `-D`.
   */
  private noteLocalFail(serial: string, ip: string, reason: string): void {
    if (this.failingSerials.has(serial)) {
      this.log.debug(`[LOCAL] ${serial} @ ${ip}: still failing — ${reason}`);
      return;
    }
    this.failingSerials.add(serial);
    if (this.debugMode) {
      this.log.info(`[LOCAL] ${serial} @ ${ip}: local read failing — ${reason}`);
    }
  }

  private noteLocalOk(serial: string): void {
    if (this.failingSerials.delete(serial) && this.debugMode) {
      this.log.info(`[LOCAL] ${serial}: local reads recovered`);
    }
  }

  setCreds(serial: string, creds: LocalDeviceCreds): void {
    this.creds.set(serial, creds);
  }

  clearCreds(serial: string): void {
    this.creds.delete(serial);
  }

  hasLocal(serial: string): boolean {
    return this.creds.has(serial);
  }

  getIp(serial: string): string | undefined {
    return this.creds.get(serial)?.ip;
  }

  /** Run `fn` after any in-flight request for this serial completes (per-device mutex). */
  private withLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(serial) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    // Swallow errors on the stored chain so one failure doesn't reject the next caller.
    this.chains.set(serial, next.catch(() => undefined));
    return next;
  }

  /**
   * Send a signed PUT and return the parsed `r` object, or null on any failure
   * (timeout, network error, auth error, malformed reply). Null means "no data" —
   * never interpret it as a device state.
   */
  async request(serial: string, body: Buffer): Promise<Record<string, unknown> | null> {
    const creds = this.creds.get(serial);
    if (!creds) {
      return null;
    }

    return this.withLock(serial, async () => {
      const token = computeLocalToken(creds.password, creds.cryptoSerial, body);
      // Bound the WHOLE request — headers AND the body read — with an AbortController.
      // node-fetch resolves as soon as headers arrive, so a unit that returns headers
      // then stalls the body would hang `res.json()` forever (the body stream has no
      // timeout of its own), permanently wedging this serial's lock chain and — since
      // the poll loop awaits each getStatus sequentially — the whole local poll loop.
      // Aborting tears the body stream down, rejects the read, and cancels the socket
      // (so a dead unit can't leak connections). This replaced a `Promise.race` that
      // only covered the headers. See
      // docs/superpowers/specs/2026-08-14-streaming-local-resilience-design.md.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`http://${creds.ip}/api?m=${token}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
          },
          body,
          // Node's global AbortSignal vs node-fetch's own signal type — same object
          // at runtime, disjoint lib typings in this tsconfig (see kumo-api.ts).
          signal: controller.signal as unknown as RequestInit['signal'],
        });
        const json = await res.json().catch(() => null) as Record<string, unknown> | null;
        // An abort fired mid-body surfaces as a rejected res.json() (swallowed to null
        // above), not as a throw — so check the signal explicitly to label it a timeout
        // rather than a malformed reply.
        if (controller.signal.aborted) {
          this.noteLocalFail(serial, creds.ip, `timed out after ${this.timeoutMs}ms`);
          return null;
        }
        if (json && json.r && typeof json.r === 'object') {
          this.noteLocalOk(serial);
          return json.r as Record<string, unknown>;
        }
        this.noteLocalFail(
          serial,
          creds.ip,
          json && json._api_error ? `api error ${json._api_error}` : 'malformed reply',
        );
        return null;
      } catch (err) {
        const e = err as Error;
        const timedOut = controller.signal.aborted || e.name === 'AbortError';
        this.noteLocalFail(
          serial,
          creds.ip,
          timedOut ? `timed out after ${this.timeoutMs}ms` : `request failed (${e.message})`,
        );
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** Read and map the unit's current status locally, or null if unreachable. */
  async getStatus(serial: string): Promise<Partial<DeviceStatus> | null> {
    const r = await this.request(serial, STATUS_READ_BODY);
    const indoorUnit = r?.indoorUnit as Record<string, unknown> | undefined;
    const status = indoorUnit?.status as Record<string, unknown> | undefined;
    if (!status || status.roomTemp === undefined) {
      return null;
    }
    return mapLocalStatus(status);
  }

  /** Send a control command locally. Returns true iff the unit acknowledged with `r`. */
  async sendCommand(serial: string, commands: Commands): Promise<boolean> {
    const body = buildLocalCommandBody(commands);
    const r = await this.request(serial, body);
    return r !== null;
  }
}

// ---- LAN discovery --------------------------------------------------------
// The cloud provides neither the unit's IP nor its MAC, so we find each unit by
// sweeping the subnet and seeing which adapter authenticates which device's token.

export interface SerialCreds {
  password: string; // base64
  cryptoSerial: string; // hex
}

/** Enumerate the /24 a host IPv4 sits on (x.y.z.1 .. .254), excluding the host itself. */
export function enumerateSubnet(hostIpv4: string): string[] {
  const m = hostIpv4.match(/^(\d+\.\d+\.\d+)\.(\d+)$/);
  if (!m) {
    return [];
  }
  const prefix = m[1];
  const self = Number(m[2]);
  const ips: string[] = [];
  for (let i = 1; i <= 254; i++) {
    if (i !== self) {
      ips.push(`${prefix}.${i}`);
    }
  }
  return ips;
}

/**
 * Parse the Linux ARP cache (`/proc/net/arp`) into a lowercase-MAC → IPv4 map.
 * Format (whitespace-separated, one header line):
 *   IP address   HW type   Flags   HW address          Mask   Device
 *   192.168.50.5 0x1       0x2     dc:ef:ca:0a:4a:d9   *      eth0
 * Skips the header, incomplete entries (flags `0x0` or the all-zero MAC), and any
 * malformed row. Pure + exported so the resolution logic is unit-testable without fs.
 */
export function parseArpTable(procNetArp: string): Map<string, string> {
  const macToIp = new Map<string, string>();
  const lines = procNetArp.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length < 4) {
      continue;
    }
    const ip = cols[0];
    const flags = cols[2];
    const mac = cols[3].toLowerCase();
    if (flags === '0x0' || mac === '00:00:00:00:00:00' || !/^(\d+\.){3}\d+$/.test(ip)) {
      continue;
    }
    if (!macToIp.has(mac)) {
      macToIp.set(mac, ip);
    }
  }
  return macToIp;
}

/**
 * Given each device's MAC and a MAC→IP map (e.g. from parseArpTable), return the
 * serial→IP candidates we can try before a full subnet sweep. Case-insensitive on
 * the MAC. These are candidates only — the caller still verifies each with the
 * signed token probe, so a stale ARP entry simply fails to match and falls through.
 */
export function candidateIpsByMac(
  macBySerial: Map<string, string>,
  macToIp: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [serial, mac] of macBySerial) {
    const ip = mac ? macToIp.get(mac.toLowerCase()) : undefined;
    if (ip) {
      out.set(serial, ip);
    }
  }
  return out;
}

type ProbeResult = 'match' | 'kumo' | null;

/**
 * Probe one IP with one device's token via a status read:
 *  - 'match' → the adapter authenticated this device (returns r.indoorUnit): IP found
 *  - 'kumo'  → a Kumo adapter, but a different device (returns _api_error)
 *  - null    → unreachable / not a Kumo adapter
 */
async function probeIpForSerial(ip: string, creds: SerialCreds, timeoutMs: number): Promise<ProbeResult> {
  // Same AbortController bounding as LocalKumoClient.request — a stalled body read
  // during a subnet sweep must not hang a discovery worker indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = computeLocalToken(creds.password, creds.cryptoSerial, STATUS_READ_BODY);
    const res = await fetch(`http://${ip}/api?m=${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': '*/*' },
      body: STATUS_READ_BODY,
      signal: controller.signal as unknown as RequestInit['signal'],
    });
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (json && json.r && typeof json.r === 'object' && (json.r as Record<string, unknown>).indoorUnit) {
      return 'match';
    }
    if (json && json._api_error) {
      return 'kumo';
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const run = async (): Promise<void> => {
    while (idx < items.length) {
      await fn(items[idx++]);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(run());
  }
  await Promise.all(workers);
}

/**
 * Sweep candidate IPs and return a serial→IP map by matching each device's token
 * to the adapter that authenticates it. ~5s for a /24 in practice (verified).
 */
export async function discoverDeviceIps(
  log: Logger,
  candidateIps: string[],
  creds: Map<string, SerialCreds>,
  opts: { concurrency?: number; timeoutMs?: number; warnUnfound?: boolean } = {},
): Promise<Map<string, string>> {
  const concurrency = opts.concurrency ?? 24;
  const timeoutMs = opts.timeoutMs ?? 3500;
  const warnUnfound = opts.warnUnfound ?? true;
  const found = new Map<string, string>();
  const remaining = new Set(creds.keys());

  await mapLimit(candidateIps, concurrency, async (ip) => {
    if (remaining.size === 0) {
      return;
    }
    for (const serial of [...remaining]) {
      const result = await probeIpForSerial(ip, creds.get(serial)!, timeoutMs);
      if (result === 'match') {
        found.set(serial, ip);
        remaining.delete(serial);
        log.info(`[LOCAL] Discovered ${serial} at ${ip}`);
        break;
      }
      if (result === null) {
        break; // not a reachable Kumo host — don't bother trying the other serials
      }
      // 'kumo': a Kumo adapter that isn't this serial — try the next serial here
    }
  });

  if (remaining.size > 0 && warnUnfound) {
    log.warn(`[LOCAL] ${remaining.size} device(s) not found on the LAN (will use cloud): ${[...remaining].join(', ')}`);
  }
  return found;
}
