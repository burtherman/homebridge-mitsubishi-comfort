'use strict';

// Ported from homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0,
// test/temperature.test.js @ 44fb5f5), unchanged.

// Regression test for Fahrenheit-anchored setpoint quantization.
//
// The Home app is Celsius-native and converts to °F only for display, so a "72°F"
// tap arrives as an arbitrary Celsius float. Upstream set HAP `minStep: 0.1` on the
// setpoint characteristics believing that would make °F round-trip; it does not.
// hap-nodejs applies minStep only on the OUTBOUND path (`validateUserInput`) — the
// inbound controller-write path (`validateClientSuppliedValue`) returns the float
// verbatim. The minStep grid is also anchored at `minValue`, so with minValue 10 a
// 72°F write lands on 10 + 122 * 0.1 = 22.200000000000003 (IEEE-754 dirt that then
// leaks into commands, logs and mirror signatures).
//
// Separately, rounding lived in the LAN transport only (`round1` in local-api.ts) and
// never on the cloud path, so the same tap stored a different value depending on
// which transport won. quantizeSetpointC sits above both transports and snaps every
// write to the 0.5°C step nearest a whole °F (the cloud rejects finer values).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cToF,
  fToC,
  quantizeSetpointC,
  quantizeSetpointInRange,
  sameSetpoint,
} = require('../dist/temperature.js');

/** What the Home app would show for a stored Celsius value. */
function displayedF(c) {
  return Math.round(cToF(c));
}

// ---- Conversions ---------------------------------------------------------

test('cToF / fToC are exact at the anchors', () => {
  assert.equal(cToF(0), 32);
  assert.equal(cToF(100), 212);
  assert.equal(fToC(32), 0);
  assert.equal(fToC(212), 100);
});

// ---- Exhaustive °F round-trip -------------------------------------------

test('every whole °F from 50 to 90 round-trips through 0.5°C storage', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.equal(displayedF(stored), f,
      `${f}°F stored as ${stored}°C displays back as ${displayedF(stored)}°F`);
  }
});

test('the whole-°F round-trip survives ±0.2°C of controller jitter', () => {
  for (let f = 50; f <= 90; f++) {
    for (const jitter of [-0.2, -0.05, 0, 0.05, 0.2]) {
      const stored = quantizeSetpointC(fToC(f) + jitter);
      assert.equal(displayedF(stored), f,
        `${f}°F + ${jitter}°C should still land on ${f}°F, got ${displayedF(stored)}°F`);
    }
  }
});

// ---- The 0.5°C grid the cloud enforces -----------------------------------
//
// Live log 2026-11-09: the Kumo v3 cloud accepted spHeat 19.5 and rejected 18.4,
// 18.9, 20.6, 21.2 and 21.7 (the old 0.1 grid values for 65, 66, 69, 70 and 71°F)
// with 400 {"error":{"commands":"invalidSpHeatIncrement"}}.

test('every stored value is a multiple of 0.5°C', () => {
  for (let f = 40; f <= 100; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.equal(stored * 2, Math.round(stored * 2), `${f}°F stored as ${stored}°C, off the 0.5 grid`);
  }
});

test('the setpoints the cloud rejected now land on accepted values', () => {
  assert.equal(quantizeSetpointC(18.4), 18.5, '65°F');
  assert.equal(quantizeSetpointC(18.9), 19, '66°F');
  assert.equal(quantizeSetpointC(20.6), 20.5, '69°F');
  assert.equal(quantizeSetpointC(21.2), 21, '70°F');
  assert.equal(quantizeSetpointC(21.7), 21.5, '71°F');
  assert.equal(quantizeSetpointC(19.5), 19.5, '67°F was already accepted and is unchanged');
});

test('72°F lands on 22.0°C, the nearest 0.5 step', () => {
  const stored = quantizeSetpointC(fToC(72));
  assert.equal(stored, 22);
  assert.equal(displayedF(stored), 72);
});

test('the stored value is within 0.45°F of its degree', () => {
  for (let f = 50; f <= 90; f++) {
    const back = cToF(quantizeSetpointC(fToC(f)));
    assert.ok(Math.abs(back - f) <= 0.45 + 1e-9, `${f}°F stored back as ${back}°F`);
  }
});

test('distinct whole °F map to distinct stored values (no two-°F collapse)', () => {
  const seen = new Set();
  for (let f = 50; f <= 90; f++) {
    seen.add(quantizeSetpointC(fToC(f)));
  }
  assert.equal(seen.size, 41, 'each of the 41 °F degrees gets its own 0.5°C slot');
});

// ---- Float noise ---------------------------------------------------------

test('results never carry IEEE-754 dirt', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    assert.equal(stored, Number(stored.toFixed(1)),
      `${stored} is not a clean one-decimal value`);
  }
});

test('the upstream minStep grid value is cleaned up, not passed through', () => {
  // What hap-nodejs' minValue-anchored 0.1 grid actually produces for 72°F.
  const dirty = 10 + Math.round((fToC(72) - 10) / 0.1) * 0.1;
  assert.notEqual(dirty, 22.2, 'sanity: the upstream grid really is dirty');

  const stored = quantizeSetpointC(dirty);
  assert.equal(stored, 22, 'the dirty 72°F value is re-snapped onto the 0.5 grid');
  assert.equal(stored, Number(stored.toFixed(1)));
});

// ---- Idempotence ---------------------------------------------------------

test('quantizeSetpointC is idempotent across the usable range', () => {
  for (let c = 5; c <= 40; c += 0.05) {
    const once = quantizeSetpointC(c);
    assert.equal(quantizeSetpointC(once), once, `not idempotent at ${c}`);
  }
});

test('quantizeSetpointInRange is idempotent, including outside the range', () => {
  for (let c = 5; c <= 40; c += 0.05) {
    const once = quantizeSetpointInRange(c, 10, 31);
    assert.equal(quantizeSetpointInRange(once, 10, 31), once, `not idempotent at ${c}`);
  }
});

// ---- Range clamping stays on the °F grid --------------------------------

test('an in-range value is still snapped to the grid, not passed through raw', () => {
  // "In range" does not mean "leave alone": a source setpoint sitting off the
  // grid (e.g. mirrored from a unit set in Celsius) must still be snapped, or it
  // propagates the display drift this module exists to remove.
  assert.equal(quantizeSetpointInRange(fToC(68), 10, 31), quantizeSetpointC(fToC(68)));
  assert.equal(quantizeSetpointInRange(fToC(72), 10, 31), 22);
  assert.equal(quantizeSetpointInRange(22.3, 10, 31), 22, 'an off-grid in-range value is snapped');
});

test('the real 10–31°C device range: below the floor snaps up to 50°F', () => {
  // 10°C is exactly 50°F, so the bottom bound is itself on the grid.
  assert.equal(quantizeSetpointInRange(9.4, 10, 31), 10);
  assert.equal(quantizeSetpointInRange(0, 10, 31), 10);
  assert.equal(displayedF(quantizeSetpointInRange(0, 10, 31)), 50);
});

test('the real 10–31°C device range: requests above the top stay inside, on the grid', () => {
  // 88°F is 31.11°C and stores as 31.0, inside the range. 89°F stores as 31.5,
  // outside, so it walks down to the highest whole °F that fits: 88°F = 31.0.
  assert.equal(quantizeSetpointInRange(fToC(88), 10, 31), 31);
  const out = quantizeSetpointInRange(fToC(89), 10, 31);
  assert.equal(out, 31);
  assert.equal(displayedF(out), 88);
  assert.ok(out <= 31, 'never above the device max');
});

test('clamped values stay inside the range and on the °F grid', () => {
  const min = 10;
  const max = 31;
  for (let f = 40; f <= 100; f++) {
    const out = quantizeSetpointInRange(fToC(f), min, max);
    assert.ok(out >= min && out <= max, `${f}°F produced ${out}°C, outside [${min},${max}]`);
    assert.equal(out, Number(out.toFixed(1)), `${out} is not a clean one-decimal value`);
    assert.equal(out * 2, Math.round(out * 2), `${out} is off the 0.5 grid`);
    // On the grid: the stored value is the storage form of its own displayed °F.
    assert.equal(out, quantizeSetpointC(out), `${out}°C is off the °F grid`);
  }
});

test('a range whose bounds are whole °F keeps results inside and on the grid', () => {
  const min = fToC(60); // 15.5555…, stores as 15.5 (just below the bound)
  const max = fToC(80); // 26.6666…, stores as 26.5 (inside)
  const low = quantizeSetpointInRange(fToC(55), min, max);
  assert.ok(low >= min - 0.05, `${low} below ${min}`);
  assert.equal(low * 2, Math.round(low * 2), 'on the 0.5 grid');
  assert.equal(quantizeSetpointInRange(fToC(85), min, max), 26.5);
  assert.equal(displayedF(quantizeSetpointInRange(fToC(85), min, max)), 80);
});

test('the resolution allowance never loosens a bound that is on the 0.1°C grid', () => {
  // Both bound and candidate are multiples of 0.1 there, so an out-of-range
  // candidate misses by a full 0.1 — well outside the 0.05 allowance.
  for (let tenths = 100; tenths <= 320; tenths++) {
    const max = tenths / 10;
    const out = quantizeSetpointInRange(40, 10, max);
    assert.ok(out <= max, `max ${max} was exceeded by ${out}`);
  }
});

test('a range narrower than 1°F falls back to the range edge, still inside', () => {
  // No whole °F lies in [10.1, 10.4] (50°F = 10.0, 51°F = 10.6).
  const low = quantizeSetpointInRange(5, 10.1, 10.4);
  assert.ok(low >= 10.1 && low <= 10.4, `${low} escaped [10.1,10.4]`);
  const high = quantizeSetpointInRange(40, 10.1, 10.4);
  assert.ok(high >= 10.1 && high <= 10.4, `${high} escaped [10.1,10.4]`);
});

test('a float-dirty bound does not push the result out of range', () => {
  const max = 22.000000000000004; // a float-dirty form of the 72°F grid point
  const out = quantizeSetpointInRange(fToC(75), 10, max);
  assert.ok(out <= max + 0.05, `${out} exceeded the dirty max ${max}`);
  assert.equal(out, 22, 'the bound itself is reachable despite the trailing dirt');
});

// ---- sameSetpoint tolerance ---------------------------------------------

test('sameSetpoint is true within half a 0.1°C step', () => {
  assert.ok(sameSetpoint(22.2, 22.2));
  assert.ok(sameSetpoint(22.2, 22.24));
  assert.ok(sameSetpoint(22.2, 22.16));
  assert.ok(sameSetpoint(22.2, 22.200000000000003), 'float dirt is not a change');
});

test('sameSetpoint is false beyond half a 0.1°C step', () => {
  assert.ok(!sameSetpoint(22.2, 22.26));
  assert.ok(!sameSetpoint(22.2, 22.3), 'one 0.1°C step apart is a real change');
  assert.ok(!sameSetpoint(22.2, 22.8), 'one °F apart is a real change');
});

test('adjacent °F setpoints are never mistaken for the same setpoint', () => {
  for (let f = 50; f < 90; f++) {
    const a = quantizeSetpointC(fToC(f));
    const b = quantizeSetpointC(fToC(f + 1));
    assert.ok(!sameSetpoint(a, b), `${f}°F and ${f + 1}°F compared equal`);
  }
});
