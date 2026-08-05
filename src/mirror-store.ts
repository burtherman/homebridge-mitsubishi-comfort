import * as fs from 'fs';
import type { Logger } from 'homebridge';

/**
 * On-disk memory of each mirror source's last-seen state signature, one JSON
 * file in the Homebridge storage dir.
 *
 * Why this exists: mirroring is edge-triggered, and the first observation after
 * a restart deliberately seeds the baseline *without* pushing — a reboot is not
 * "someone changed the kitchen", so a manually-adjusted target survives it. That
 * rule also silently swallows a source change that happened while the plugin was
 * DOWN, which is a real change we simply weren't running to see.
 *
 * Observed live 2026-08-05: `hb-service update-node` left a truncated Node binary,
 * Homebridge crash-looped on SIGSEGV for 41 minutes, the kitchen was switched on
 * at the wall during the outage, and afterwards the living room sat off with
 * nothing left to re-sync it — the mirror had seeded its baseline from the
 * already-changed state and had no way to know it had missed an edge.
 *
 * Persisting the signature lets the controller tell the two cases apart at
 * startup: unchanged since shutdown → seed silently as before; different → the
 * source moved while we were down, so mirror it.
 *
 * This is a cache, not a source of truth. A missing or corrupt file degrades to
 * exactly the old seed-only behavior and must never block startup. Signatures
 * hold no secrets — mode, setpoints and fan speed only.
 */

export function loadMirrorStore(file: string, log: Logger): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (!fs.existsSync(file)) {
      return out;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [serial, v] of Object.entries((data?.sources ?? {}) as Record<string, unknown>)) {
      if (typeof v === 'string') {
        out.set(serial, v);
      }
    }
    log.debug(`Mirror state store: loaded ${out.size} source(s)`);
  } catch (e) {
    // A corrupt store must never block startup — it is a cache, not a source.
    log.warn(`Mirror state store unreadable (${e instanceof Error ? e.message : String(e)}) — starting empty`);
  }
  return out;
}

export function saveMirrorStore(file: string, sigs: Map<string, string>, log: Logger): void {
  try {
    const sources: Record<string, string> = {};
    for (const [serial, sig] of sigs) {
      sources[serial] = sig;
    }
    // Write-then-rename so a crash mid-write can't leave a truncated store.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sources }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn(`Mirror state store write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
