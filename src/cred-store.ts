import * as fs from 'fs';
import type { Logger } from 'homebridge';
import { SerialCreds } from './local-api';

/**
 * On-disk cache of local-control credentials, one JSON file in the Homebridge
 * storage dir, mode 0600.
 *
 * Why this exists: the adapter password is only ever DELIVERED over the cloud's
 * `adapter_update` socket push, on the adapter's own schedule — observed
 * arriving 2.5h after startup (Front bedroom, 2026-07-28) or never (Living
 * room, whose report channel has been down since 07-24). Holding it in memory
 * only meant every Homebridge restart re-ran that lottery. The 2026-07-28
 * restarts threw away a working credential and stranded a unit back on cloud
 * control for hours.
 *
 * Trust model is identical to the legacy-v2 fallback: entries here are
 * CANDIDATES, not truth. The LAN sweep's signed probe validates every
 * credential before a device is admitted, so a rotated password degrades to
 * cloud control exactly as if no credential existed. Never log secrets —
 * serials and counts only.
 *
 * The file also rides along in Homebridge UI backups, which is acceptable for a
 * LAN-scoped per-device secret (the same backup already contains the full Kumo
 * cloud login in config.json — strictly more sensitive).
 */

interface StoredCred extends SerialCreds {
  capturedAt: string;   // ISO time the value was first seen (unchanged on rewrites)
}

export function loadCredStore(file: string, log: Logger): Map<string, StoredCred> {
  const out = new Map<string, StoredCred>();
  try {
    if (!fs.existsSync(file)) {
      return out;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [serial, v] of Object.entries((data?.devices ?? {}) as Record<string, unknown>)) {
      const c = v as Record<string, unknown>;
      if (typeof c.password === 'string' && typeof c.cryptoSerial === 'string') {
        out.set(serial, {
          password: c.password,
          cryptoSerial: c.cryptoSerial,
          capturedAt: typeof c.capturedAt === 'string' ? c.capturedAt : new Date().toISOString(),
        });
      }
    }
    log.debug(`Local credential store: loaded ${out.size} device(s)`);
  } catch (e) {
    // A corrupt store must never block startup — it is a cache, not a source.
    log.warn(`Local credential store unreadable (${e instanceof Error ? e.message : String(e)}) — starting empty`);
  }
  return out;
}

export function saveCredStore(file: string, creds: Map<string, StoredCred>, log: Logger): void {
  try {
    const devices: Record<string, StoredCred> = {};
    for (const [serial, c] of creds) {
      devices[serial] = c;
    }
    // Write-then-rename so a crash mid-write can't leave a truncated store;
    // mode lands on the temp file and survives the rename.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn(`Local credential store write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
