import fs from 'fs';

/**
 * TEMPORARY diagnostic (2.0 soak). Runs only in debug mode. Remove once a dropout has
 * been caught and a real check built on what it shows.
 *
 * A cloud-only unit (ours: the front bedroom) can be cut off from the cloud while the
 * cloud still calls it connected, and with no HomeKit command sent nothing notices:
 * on 2026-10-11 the cloud showed its fan on from 05:26 to 20:14 and the plugin never
 * flagged it. Unanswered status requests can't be the signal on their own (a healthy
 * unit ignores about one in three), so this records, every few minutes, three things
 * per cloud-only unit and never touches HomeKit:
 *  - whether the last status request got a device_update back,
 *  - the cloud's room temperature and how long it has sat unchanged,
 *  - whether the adapter still answers on the LAN.
 * Every sample goes to its own file (the Homebridge log rolls over in about a week);
 * the Homebridge log only gets the rare changes worth a look.
 */

export interface LinkWatchTarget {
  serial: string;
  name: string;
  /** Reached only through the cloud. LAN units are read directly and aren't watched. */
  cloudOnly: boolean;
  /** When the last streaming device_update for this unit arrived (ms), 0 if none. */
  lastCloudUpdateAt: number;
  roomTemp?: number;
  mode?: string;
  /** What HomeKit is being told: false means No Response. */
  reachable: boolean;
}

/** 'answers' = something answered at its address; 'silent' = nothing did. */
export type LanAnswer = 'answers' | 'silent' | 'unknown';

export interface LinkWatchDeps {
  targets: () => LinkWatchTarget[];
  requestStatus: (serial: string) => void;
  streamInterruptedSince: (since: number) => boolean;
  lanProbe: (serial: string) => Promise<{ answer: LanAnswer; ip?: string }>;
  /** When the adapter last reported to the cloud (`/status` lastUpdated), ms. */
  adapterReportedAt: (serial: string) => Promise<number | null>;
  log: { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void };
  /** Sample file; null keeps the samples out of any file (main-log lines still appear). */
  file: string | null;
  now?: () => number;
}

interface UnitState {
  askedAt: number;
  misses: number;
  lan: LanAnswer;
  reportedAt: number | null;
  roomTemp?: number;
  tempSince: number;
}

export const LINK_WATCH_MAX_BYTES = 1024 * 1024;
/** Unanswered requests in a row before the Homebridge log gets a line. */
export const LINK_WATCH_MISS_NOTE = 6;

/** Local time, like the Homebridge log, so the two can be read side by side. */
function stamp(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE');
}

export class LinkWatch {
  private readonly units = new Map<string, UnitState>();

  constructor(private readonly deps: LinkWatchDeps) {}

  async tick(): Promise<void> {
    for (const target of this.deps.targets()) {
      if (!target.cloudOnly) {
        this.units.delete(target.serial);
        continue;
      }
      try {
        await this.sample(target);
      } catch (e) {
        this.deps.log.debug(`[LINK WATCH] ${target.name}: sample failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async sample(t: LinkWatchTarget): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const log = this.deps.log;
    let u = this.units.get(t.serial);
    const first = !u;
    if (!u) {
      u = { askedAt: 0, misses: 0, lan: 'unknown', reportedAt: null, roomTemp: t.roomTemp, tempSince: now };
      this.units.set(t.serial, u);
    }

    // The request sent last time round.
    let request = 'first';
    if (u.askedAt) {
      if (t.lastCloudUpdateAt >= u.askedAt) {
        request = 'answered';
        if (u.misses >= LINK_WATCH_MISS_NOTE) {
          log.info(`[LINK WATCH] ${t.name}: answered a status request again, after ${u.misses} with no answer`);
        }
        u.misses = 0;
      } else if (this.deps.streamInterruptedSince(u.askedAt)) {
        request = 'stream-down';
      } else {
        request = 'unanswered';
        u.misses += 1;
        if (u.misses === LINK_WATCH_MISS_NOTE) {
          log.warn(`[LINK WATCH] ${t.name}: no answer to the last ${u.misses} status requests`);
        }
      }
    }

    if (t.roomTemp !== u.roomTemp) {
      u.roomTemp = t.roomTemp;
      u.tempSince = now;
    }

    const lan = await this.deps.lanProbe(t.serial);
    if (lan.answer !== u.lan && u.lan !== 'unknown' && lan.answer !== 'unknown') {
      const where = lan.ip ? ` (${lan.ip})` : '';
      if (lan.answer === 'silent') {
        log.warn(`[LINK WATCH] ${t.name}: its adapter stopped answering on the LAN${where}`);
      } else {
        log.info(`[LINK WATCH] ${t.name}: its adapter answers on the LAN again${where}`);
      }
    }
    if (lan.answer !== 'unknown' || first) {
      u.lan = lan.answer;
    }

    const reportedAt = await this.deps.adapterReportedAt(t.serial).catch(() => null);
    if (reportedAt !== null) {
      if (u.reportedAt !== null && reportedAt > u.reportedAt) {
        log.info(`[LINK WATCH] ${t.name}: its adapter checked in with the cloud at ${stamp(reportedAt)}`);
      }
      u.reportedAt = reportedAt;
    }

    this.write(
      `${stamp(now)} ${t.name} request=${request} misses=${u.misses} ` +
      `temp=${t.roomTemp ?? '?'} tempUnchangedMin=${Math.round((now - u.tempSince) / 60000)} mode=${t.mode ?? '?'} ` +
      `lan=${lan.answer}${lan.ip ? `@${lan.ip}` : ''} ` +
      `adapterReport=${u.reportedAt !== null ? stamp(u.reportedAt).replace(' ', 'T') : '?'} ` +
      `homekit=${t.reachable ? 'ok' : 'no-response'}`,
    );

    u.askedAt = now;
    this.deps.requestStatus(t.serial);
  }

  private write(line: string): void {
    const file = this.deps.file;
    if (!file) {
      return;
    }
    try {
      // One older file is kept, so the pair covers roughly five weeks for one unit.
      if (fs.existsSync(file) && fs.statSync(file).size > LINK_WATCH_MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${line}\n`);
    } catch (e) {
      this.deps.log.debug(`[LINK WATCH] could not write ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
