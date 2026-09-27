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
// write to the exact 0.1°C that displays back as a whole °F.

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

test('every whole °F from 50 to 90 round-trips through 0.1°C storage', () => {
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

test('72°F lands on 22.3°C, ABOVE the degree, not 22.2 below it', () => {
  // The grid takes the CEILING of the exact conversion, not the nearest 0.1.
  // 72°F is 22.2222°C; rounding gives 22.2 (= 71.96°F) and ceiling gives 22.3
  // (= 72.14°F). The difference decides whether a truncating renderer shows 72
  // or 71 — see the truncation test below and src/temperature.ts.
  const stored = quantizeSetpointC(fToC(72));
  assert.equal(stored, 22.3);
  assert.ok(cToF(stored) >= 72, `${cToF(stored)}°F must not fall below the degree`);
  assert.equal(displayedF(stored), 72);
});

// ---- The reason the grid ceilings instead of rounding --------------------
//
// Measured on real hardware 2026-07-27: the Mitsubishi Comfort app TRUNCATES
// when it renders Celsius as Fahrenheit, while the Apple Home app rounds. The
// Family Room held spCool 22.200001°C (71.96°F) and the two apps showed 72 and
// 71 at the same moment. Rounding to 0.1 can land just under the target degree,
// which only survives a rounding renderer; the ceiling always lands on or just
// above it, which survives both.

test('every whole °F survives a TRUNCATING renderer, not just a rounding one', () => {
  for (let f = 50; f <= 90; f++) {
    const stored = quantizeSetpointC(fToC(f));
    const back = cToF(stored);
    assert.equal(Math.floor(back + 1e-9), f,
      `${f}°F stored as ${stored}°C is ${back}°F, which truncates to ${Math.floor(back)}°F`);
    assert.equal(Math.round(back), f,
      `${f}°F stored as ${stored}°C is ${back}°F, which rounds to ${Math.round(back)}°F`);
  }
});

test('the stored value never sits below its target degree', () => {
  for (let f = 50; f <= 90; f++) {
    const back = cToF(quantizeSetpointC(fToC(f)));
    assert.ok(back >= f - 1e-9, `${f}°F stored back as ${back}°F, below the degree`);
    assert.ok(back < f + 0.2, `${f}°F stored back as ${back}°F, more than 0.2°F above`);
  }
});

test('distinct whole °F map to distinct stored values (no two-°F collapse)', () => {
  const seen = new Set();
  for (let f = 50; f <= 90; f++) {
    seen.add(quantizeSetpointC(fToC(f)));
  }
  assert.equal(seen.size, 41, 'each of the 41 °F degrees gets its own 0.1°C slot');
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
  assert.equal(stored, 22.3, 'the dirty 72°F value is re-snapped onto the ceiling grid');
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
  assert.equal(quantizeSetpointInRange(fToC(72), 10, 31), 22.3);
  assert.equal(quantizeSetpointInRange(22.15, 10, 31), 22.3, 'an off-grid in-range value is snapped');
});

test('the real 10–31°C device range: below the floor snaps up to 50°F', () => {
  // 10°C is exactly 50°F, so the bottom bound is itself on the grid.
  assert.equal(quantizeSetpointInRange(9.4, 10, 31), 10);
  assert.equal(quantizeSetpointInRange(0, 10, 31), 10);
  assert.equal(displayedF(quantizeSetpointInRange(0, 10, 31)), 50);
});

test('the real 10–31°C device range: a 88°F request lands inside, on the grid', () => {
  // 31°C is 87.8°F — not a whole °F. 88°F would quantize to 31.1°C, outside the
  // range, so the value floors to the highest whole °F that fits: 87°F = 30.6°C.
  const out = quantizeSetpointInRange(fToC(88), 10, 31);
  assert.equal(out, 30.6);
  assert.equal(displayedF(out), 87);
  assert.ok(out <= 31, 'never above the device max');
});

test('clamped values stay inside the range and on the °F grid', () => {
  const min = 10;
  const max = 31;
  for (let f = 40; f <= 100; f++) {
    const out = quantizeSetpointInRange(fToC(f), min, max);
    assert.ok(out >= min && out <= max, `${f}°F produced ${out}°C, outside [${min},${max}]`);
    assert.equal(out, Number(out.toFixed(1)), `${out} is not a clean one-decimal value`);
    // On the grid: the stored value is the storage form of its own displayed °F.
    assert.equal(out, quantizeSetpointC(out), `${out}°C is off the °F grid`);
  }
});

test('a range whose bounds are whole °F keeps both endpoints reachable', () => {
  // 80°F is 26.6666…°C but is *stored* as 26.7 — 0.033°C above the bound. Judging
  // containment exactly would reject the range's own endpoint and hand back 79°F,
  // silently shaving a degree off the top of the slider. Containment is therefore
  // judged to within half the 0.1°C device resolution.
  const min = fToC(60); // 15.5555…
  const max = fToC(80); // 26.6666…
  assert.equal(quantizeSetpointInRange(fToC(55), min, max), 15.6);
  assert.equal(displayedF(quantizeSetpointInRange(fToC(55), min, max)), 60);
  assert.equal(quantizeSetpointInRange(fToC(85), min, max), 26.7);
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
  const max = 22.300000000000004; // a float-dirty form of the 72°F grid point
  const out = quantizeSetpointInRange(fToC(75), 10, max);
  assert.ok(out <= max + 0.05, `${out} exceeded the dirty max ${max}`);
  assert.equal(out, 22.3, 'the bound itself is reachable despite the trailing dirt');
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
