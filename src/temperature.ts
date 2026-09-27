// Portions derived from homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0,
// src/temperature.ts @ 83dfd18). Copied unchanged; the live observations in the
// comments below are the fork author's, from their own units.

/**
 * Fahrenheit-anchored setpoint quantization.
 *
 * HomeKit is Celsius-native: the Home app converts to °F only for display, and a
 * controller writing "72°F" sends whatever Celsius float its own conversion produced.
 * The units accept 0.1°C granularity (live-verified — the cloud stored a 23.3
 * setpoint exactly, never snapping to 23.5), so every whole °F has a 0.1°C
 * representation that displays back as that same whole °F. This module snaps to it.
 *
 * Why this is not handled by HAP props. Upstream set `minStep: 0.1` on the setpoint
 * characteristics believing that would make °F round-trip. It does not:
 * hap-nodejs applies minStep only on the OUTBOUND path (`validateUserInput`); the
 * inbound controller-write path (`validateClientSuppliedValue`) hands the float
 * through verbatim. The minStep grid also introduces IEEE-754 dirt of its own,
 * because it is anchored at `minValue` — with minValue 10 and minStep 0.1 a 72°F
 * write lands on `10 + 122 * 0.1 = 22.200000000000003`, which then leaks into
 * commands, logs and mirror signatures.
 *
 * Rounding also used to live in the LAN transport only (`round1` in local-api.ts) and
 * never on the cloud path, so the same HomeKit tap stored a different value depending
 * on which transport won. Quantizing here — above both transports — makes the write
 * deterministic regardless of which one carries it.
 */

/** Half of the 0.1°C device resolution: the widest gap that is still "the same setpoint". */
const SETPOINT_TOLERANCE_C = 0.05;

/** Guard for arithmetic on range bounds that may themselves carry float dirt. */
const EPS = 1e-9;

export function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

export function fToC(f: number): number {
  return (f - 32) * 5 / 9;
}

/**
 * The 0.1°C value a whole °F degree is stored as.
 *
 * CEILING, not rounding — this is the whole point of the module, and it is driven
 * by a measured fact about the vendor app rather than by taste.
 *
 * The Mitsubishi Comfort app TRUNCATES when it renders Celsius as Fahrenheit; the
 * Home app rounds. Confirmed live 2026-07-27: the Family Room held spCool
 * 22.200001°C, which is 71.96°F, and the Home app showed 72 while the Comfort app
 * showed 71 at the same moment. That one-degree split is the entire C/F complaint.
 *
 * Rounding to 0.1 lands up to 0.09°F BELOW the target degree (72°F → 22.2 →
 * 71.96°F), which a rounding renderer shows correctly and a truncating one shows
 * one degree low. Taking the ceiling instead lands 0 to 0.18°F ABOVE it (72°F →
 * 22.3 → 72.14°F), which is correct under BOTH: truncation floors 72.14 to 72,
 * and rounding is nowhere near the 0.5 needed to reach 73.
 *
 * Cost of the choice: at most 0.0999°C (0.18°F) warmer than the exact conversion,
 * and a stored value that differs by 0.1°C from what a round-to-0.1 writer would
 * have produced for the same degree. Both are far below anything perceptible, and
 * both apps then agree on the number.
 */
function storedC(f: number): number {
  const exact = fToC(f);
  // EPS absorbs float dirt so an exactly-representable degree (68°F = 20°C) is not
  // pushed up a whole step by a 19.999999999 intermediate.
  const ceiled = Math.ceil(exact * 10 - EPS) / 10;
  return Math.round(ceiled * 10) / 10; // clean one-decimal float, never 22.30000000000000004
}

/**
 * Snap a Celsius setpoint to the Celsius the units store for the nearest whole
 * Fahrenheit degree, at the 0.1°C resolution they accept.
 *
 * The result always displays back as the whole °F it came from, in a renderer that
 * rounds AND in one that truncates — see storedC for why that matters here.
 */
export function quantizeSetpointC(c: number): number {
  return storedC(Math.round(cToF(c)));
}

/**
 * Clamp to [min,max] AFTER quantizing, staying on the °F grid.
 *
 * A plain `Math.min/Math.max` clamp would hand back the raw bound, which is usually
 * not a whole °F (the real device range 10–31°C is 50–87.8°F) and would reintroduce
 * the half-degree display drift this module exists to remove. Instead, when the
 * quantized value falls outside the range we step along the °F grid toward the
 * interior — ceil at the bottom, floor at the top — and take the first whole °F that
 * lies inside. Note the consequence at a non-whole-°F bound: a request for 88°F
 * against a 31°C max lands on 87°F (30.6°C), not on 31°C/87.8°F, because 87.8 is not
 * a °F the display can show without drift.
 *
 * "Inside" is judged to within half the 0.1°C device resolution, not exactly. A bound
 * that is itself a whole °F — 80°F is 26.6666…°C — is stored as 26.7, which an exact
 * test would read as 0.033°C out of range and reject, making the range's own endpoint
 * unreachable. The allowance cannot loosen a bound that already sits on the 0.1°C grid
 * (every real device profile bound does): both bound and candidate are then multiples
 * of 0.1, so an out-of-range candidate misses by a full 0.1, well past the tolerance.
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
  // Fall back to the range edge itself, on the 0.1°C grid, rounded inward so the
  // result cannot land outside the range.
  return step === 1
    ? Math.ceil(min * 10 - EPS) / 10
    : Math.floor(max * 10 + EPS) / 10;
}

/**
 * True if two Celsius setpoints are the same to within half a 0.1°C step.
 *
 * Used to decide whether a write is a real change. Values that came out of
 * quantizeSetpointC are at least 0.5°C apart when they differ (1°F ≈ 0.556°C), so the
 * exact-0.05 boundary is unreachable in practice — do not rely on which side it
 * falls, floats put |22.25 - 22.2| at 0.05000000000000071.
 */
export function sameSetpoint(a: number, b: number): boolean {
  return Math.abs(a - b) < SETPOINT_TOLERANCE_C;
}
