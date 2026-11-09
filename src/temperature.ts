// Portions derived from homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0,
// src/temperature.ts @ 83dfd18). The grid changed from 0.1°C to 0.5°C in 2.0.1
// (see below); the 2026-07 live observations are the fork author's.

/**
 * Fahrenheit-anchored setpoint quantization on the 0.5°C grid the cloud accepts.
 *
 * HomeKit is Celsius-native: the Home app converts to °F only for display, and a
 * controller writing "72°F" sends whatever Celsius float its own conversion produced.
 * This module snaps every write to the 0.5°C value nearest the whole °F the user
 * picked, which the Home app then displays back as that same whole °F.
 *
 * Why 0.5°C. Through mid 2026 the cloud accepted 0.1°C granularity (live-verified
 * 2026-07: it stored a 23.3 setpoint exactly), and this module used a 0.1°C grid.
 * By November 2026 the Kumo v3 cloud rejects any setpoint that is not a multiple of
 * 0.5°C with `400 {"error":{"commands":"invalidSpHeatIncrement"}}` (and the cool
 * equivalent): live log 2026-11-09, 19.5 accepted, while 18.4, 18.9, 20.6, 21.2 and
 * 21.7 (the 0.1 grid values for 65, 66, 69, 70 and 71°F) were all rejected. That
 * left every °F setpoint not divisible by 9 unsettable from HomeKit on the cloud
 * path. The Comfort app itself stores °F setpoints in 0.5°C steps.
 *
 * Why NEAREST, not ceiling. The 0.1 grid took the ceiling so the Comfort app, which
 * truncates when rendering °F, and the Home app, which rounds, would agree. On a
 * 0.5°C grid that is no longer possible: the ceiling can land up to 0.5°C (0.9°F)
 * above the degree, which the Home app would round up to the next °F. Nearest lands
 * within 0.25°C (0.45°F) of the degree, so the Home app (this plugin's UI) always
 * shows the °F the user picked. The Comfort app may show one degree lower for some
 * setpoints, as it would for any value off its own conversion table.
 *
 * Why this is not handled by HAP props. hap-nodejs applies minStep only on the
 * OUTBOUND path (`validateUserInput`); the inbound controller-write path
 * (`validateClientSuppliedValue`) hands the float through verbatim. The minStep grid
 * also introduces IEEE-754 dirt of its own, because it is anchored at `minValue`.
 *
 * Quantizing here, above both transports, makes the write deterministic regardless
 * of whether the cloud or the LAN carries it.
 */

/** The setpoint resolution the Kumo v3 cloud accepts. */
const SETPOINT_STEP_C = 0.5;

/**
 * The widest gap that is still "the same setpoint": half of the old 0.1°C
 * resolution. Values that differ in practice differ by a whole 0.5°C step, so
 * this only absorbs float dirt and readings from units still holding 0.1 values.
 */
const SETPOINT_TOLERANCE_C = 0.05;

/** Guard for arithmetic on range bounds that may themselves carry float dirt. */
const EPS = 1e-9;

export function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

export function fToC(f: number): number {
  return (f - 32) * 5 / 9;
}

/** Round to the nearest 0.5°C, returning a clean float (never 22.000000000000004). */
function toStep(c: number): number {
  const steps = Math.round(c / SETPOINT_STEP_C + EPS);
  return Math.round(steps * SETPOINT_STEP_C * 10) / 10;
}

/**
 * The 0.5°C value a whole °F degree is stored as: the nearest one.
 *
 * Within 0.25°C (0.45°F) of the exact conversion, so it rounds back to the same °F.
 * Consecutive °F degrees are 0.556°C apart, more than one step, so no two degrees
 * share a stored value.
 */
function storedC(f: number): number {
  return toStep(fToC(f));
}

/**
 * Snap a Celsius setpoint to the 0.5°C value the units store for the nearest whole
 * Fahrenheit degree. The result always displays back as that whole °F in a
 * renderer that rounds (the Home app).
 */
export function quantizeSetpointC(c: number): number {
  return storedC(Math.round(cToF(c)));
}

/**
 * Clamp to [min,max] AFTER quantizing, staying on the °F grid.
 *
 * A plain `Math.min/Math.max` clamp would hand back the raw bound, which is not
 * necessarily the stored form of a whole °F (the real device range 10 to 31°C is
 * 50 to 87.8°F). Instead, when the quantized value falls outside the range we step
 * along the °F grid toward the interior (up at the bottom, down at the top) and
 * take the first whole °F whose stored value lies inside. Against a 31°C max, 88°F
 * stores as 31.0 and is kept; 89°F walks down to it.
 *
 * "Inside" is judged to within SETPOINT_TOLERANCE_C, which absorbs float dirt on
 * bounds without loosening a bound that already sits on the 0.1°C or 0.5°C grid.
 */
export function quantizeSetpointInRange(c: number, min: number, max: number): number {
  const lo = min - SETPOINT_TOLERANCE_C;
  const hi = max + SETPOINT_TOLERANCE_C;

  const quantized = quantizeSetpointC(c);
  if (quantized >= lo && quantized <= hi) {
    return quantized;
  }

  const step = quantized < min ? 1 : -1;
  let f = Math.round(cToF(quantized));
  // Bounded: the widest plausible range is ~50°F, and the walk bails the moment it
  // steps past the far edge. The isFinite clause makes a NaN input terminate at once.
  for (let i = 0; i < 128 && Number.isFinite(f); i++) {
    f += step;
    const candidate = storedC(f);
    if (candidate >= lo && candidate <= hi) {
      return candidate;
    }
    if (step === 1 ? candidate > hi : candidate < lo) {
      break;
    }
  }

  // No whole °F fits inside the range (it is narrower than 1°F, or degenerate).
  // Fall back to a 0.5°C step inside the range, rounded inward; if none exists,
  // the range edge itself on the 0.1°C grid.
  const inward = step === 1
    ? Math.ceil(min / SETPOINT_STEP_C - EPS) * SETPOINT_STEP_C
    : Math.floor(max / SETPOINT_STEP_C + EPS) * SETPOINT_STEP_C;
  if (inward >= lo && inward <= hi) {
    return Math.round(inward * 10) / 10;
  }
  return step === 1
    ? Math.ceil(min * 10 - EPS) / 10
    : Math.floor(max * 10 + EPS) / 10;
}

/**
 * True if two Celsius setpoints are the same to within float dirt.
 *
 * Used to decide whether a write is a real change. Values that came out of
 * quantizeSetpointC are at least 0.5°C apart when they differ.
 */
export function sameSetpoint(a: number, b: number): boolean {
  return Math.abs(a - b) < SETPOINT_TOLERANCE_C;
}
