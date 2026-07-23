import type { Logger } from 'homebridge';
import { MirrorPair, MirrorState, DeviceStatus } from './settings';
import type { KumoThermostatAccessory } from './accessory';

/**
 * Device mirroring: makes one unit (target) follow another (source).
 *
 * One-way and edge-triggered. The controller subscribes to each source
 * accessory's status updates (which fire for any observed change — wall
 * thermostat, Kumo app, streaming, local poll — and for a HomeKit change to the
 * source via its setters). When the source's *commanded* state changes it debounces
 * briefly, then pushes the source's full state to each target's applyMirror().
 *
 * Change detection is a mode-aware signature so a drifting inactive setpoint
 * (e.g. spCool while the unit is in heat, which the Home app doesn't even show)
 * can't spuriously re-clobber a manually-adjusted target. Between source changes
 * the target is free — a manual change there persists until the next source change.
 *
 * See docs/superpowers/specs/2026-07-22-device-mirroring-design.md.
 */

const DEFAULT_DEBOUNCE_MS = 1000;

interface SourceWatch {
  targets: KumoThermostatAccessory[];
  lastSignature: string | null;
  latest: MirrorState | null;
  timer: NodeJS.Timeout | null;
}

export class MirrorController {
  private readonly watches = new Map<string, SourceWatch>();

  constructor(
    private readonly log: Logger,
    pairs: MirrorPair[],
    handlers: KumoThermostatAccessory[],
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
  ) {
    const bySerial = new Map(handlers.map(h => [h.getDeviceSerial(), h]));

    for (const pair of pairs) {
      if (pair.source === pair.target) {
        this.log.warn(`[MIRROR] source === target (${pair.source}) — skipping`);
        continue;
      }
      const source = bySerial.get(pair.source);
      const target = bySerial.get(pair.target);
      if (!source) {
        this.log.warn(`[MIRROR] source device ${pair.source} not found — skipping`);
        continue;
      }
      if (!target) {
        this.log.warn(`[MIRROR] target device ${pair.target} not found — skipping`);
        continue;
      }

      let watch = this.watches.get(pair.source);
      if (!watch) {
        watch = { targets: [], lastSignature: null, latest: null, timer: null };
        this.watches.set(pair.source, watch);
        source.onStatusUpdate(status => this.onSourceUpdate(pair.source, status));
      }
      watch.targets.push(target);
      this.log.info(`[MIRROR] ${target.getDeviceSerial()} will follow ${pair.source}`);
    }
  }

  private onSourceUpdate(sourceSerial: string, status: DeviceStatus): void {
    const watch = this.watches.get(sourceSerial);
    if (!watch) {
      return;
    }
    const state = toMirrorState(status);
    watch.latest = state;
    const sig = signature(state);

    // First observation after (re)start seeds the baseline without pushing — a
    // restart isn't "someone changed the kitchen", so a manual target state survives.
    if (watch.lastSignature === null) {
      watch.lastSignature = sig;
      this.log.debug(`[MIRROR] ${sourceSerial}: baseline seeded (${sig})`);
      return;
    }
    // No change → don't clobber a manual target adjustment.
    if (sig === watch.lastSignature) {
      return;
    }
    watch.lastSignature = sig;

    // Debounce: collapse a mode+setpoint burst (or a fast drag) into one push.
    if (watch.timer) {
      clearTimeout(watch.timer);
    }
    watch.timer = setTimeout(() => {
      watch.timer = null;
      this.dispatch(sourceSerial);
    }, this.debounceMs);
  }

  private dispatch(sourceSerial: string): void {
    const watch = this.watches.get(sourceSerial);
    if (!watch || !watch.latest) {
      return;
    }
    const desired = watch.latest;
    for (const target of watch.targets) {
      target.applyMirror(desired).catch(err =>
        this.log.error(`[MIRROR] ${target.getDeviceSerial()} apply failed: ${(err as Error).message}`));
    }
  }

  destroy(): void {
    for (const watch of this.watches.values()) {
      if (watch.timer) {
        clearTimeout(watch.timer);
        watch.timer = null;
      }
    }
  }
}

/** Project a full DeviceStatus down to the fields the mirror copies. */
export function toMirrorState(s: DeviceStatus): MirrorState {
  return {
    operationMode: s.operationMode,
    power: s.power,
    spHeat: s.spHeat,
    spCool: s.spCool,
    fanSpeed: s.fanSpeed,
  };
}

/**
 * Mode-aware change signature. Only the setpoints relevant to the current mode
 * are included, so inactive-setpoint drift can't trigger a spurious re-sync.
 * autoHeat/autoCool collapse to auto; off collapses regardless of setpoints.
 */
export function signature(s: MirrorState): string {
  if (s.power === 0 || s.operationMode === 'off') {
    return 'off';
  }
  const mode = s.operationMode.startsWith('auto') ? 'auto' : s.operationMode;
  const r = (n: number) => (typeof n === 'number' && !isNaN(n) ? Math.round(n * 10) / 10 : 'x');
  const fan = s.fanSpeed || '';
  switch (mode) {
    case 'heat':
      return `heat|${r(s.spHeat)}|${fan}`;
    case 'cool':
      return `cool|${r(s.spCool)}|${fan}`;
    case 'auto':
      return `auto|${r(s.spHeat)}|${r(s.spCool)}|${fan}`;
    case 'dry':
      return `dry|${r(s.spCool)}|${fan}`;
    case 'vent':
      return `vent|${fan}`;
    default:
      return `${mode}|${r(s.spHeat)}|${r(s.spCool)}|${fan}`;
  }
}
