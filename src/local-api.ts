import { createHash } from 'crypto';
import fetch from 'node-fetch';
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
  if (commands.fanSpeed !== undefined) {
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

  constructor(
    private readonly log: Logger,
    private readonly timeoutMs: number = 6000,
  ) {}

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
      try {
        const fetchPromise = fetch(`http://${creds.ip}/api?m=${token}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
          },
          body,
        });
        // node-fetch v3 dropped the `timeout` option, so race the request against a
        // timer — an unreachable unit must not stall the poll. The losing fetch is
        // left to settle in the background; swallow its eventual rejection.
        fetchPromise.catch(() => undefined);
        const res = await Promise.race([
          fetchPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), this.timeoutMs)),
        ]);
        if (!res) {
          this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: timed out after ${this.timeoutMs}ms`);
          return null;
        }
        const json = await res.json().catch(() => null) as Record<string, unknown> | null;
        if (json && json.r && typeof json.r === 'object') {
          return json.r as Record<string, unknown>;
        }
        if (json && json._api_error) {
          this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: api error ${json._api_error}`);
        }
        return null;
      } catch (err) {
        this.log.debug(`[LOCAL] ${serial} @ ${creds.ip}: request failed (${(err as Error).message})`);
        return null;
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
