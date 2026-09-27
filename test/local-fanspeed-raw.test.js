'use strict';

// Ported from homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0,
// test/local-fanspeed-raw.test.js @ 44fb5f5), unchanged.

// Fan-speed writes on the local path, and the raw passthrough the mirror needs.
//
// History: through 1.8.2 `Commands.fanSpeed` was a coarse auto/low/medium/high
// enum that a lossy `mapFanSpeedToLocal` translated into the adapter's real
// vocabulary (auto/superQuiet/quiet/low/powerful/superPowerful). The two
// overlapped in *spelling* with DIFFERENT meanings — coarse 'low' meant local
// 'quiet', coarse 'medium' meant local 'low' — which is exactly why the mirror
// path had to add `fanSpeedRaw` to bypass the mapper. The coarse enum had no
// producer anywhere in the plugin, so it is gone: `fanSpeed` now IS the adapter
// vocabulary and nothing is translated.
//
// `fanSpeedRaw` survives for one reason: a mirror push must copy whatever string
// the *source unit reported*, which may be a speed this fork has not enumerated.
// So raw is written verbatim and unvalidated, and takes precedence over
// `fanSpeed` on the local path.
//
// Why an invalid `fanSpeed` throws rather than being dropped: the adapter does
// not validate. A write of fanSpeed:"high" returns HTTP 200 and is silently
// ignored — the unit simply never changes speed, with no error anywhere.
// buildLocalCommandBody is the only validation layer there is, and it throws
// before any I/O so nothing is half-written.

const test = require('node:test');
const assert = require('node:assert');
const { buildLocalCommandBody } = require('../dist/local-api.js');
const { toCloudCommands } = require('../dist/kumo-api.js');
const { FAN_SPEEDS } = require('../dist/settings.js');

const parseLocal = (commands) =>
  JSON.parse(buildLocalCommandBody(commands).toString('utf8')).c.indoorUnit.status;

test('local: fanSpeedRaw is written verbatim to status.fanSpeed', () => {
  const status = parseLocal({ operationMode: 'heat', spHeat: 21, fanSpeedRaw: 'powerful' });
  assert.strictEqual(status.fanSpeed, 'powerful');
  assert.strictEqual(status.mode, 'heat');
});

test('local: every named fan speed round-trips unchanged', () => {
  // No translation layer left — the RotationSpeed slider hands one of these six
  // straight through. superQuiet/superPowerful had no coarse equivalent at all
  // and were unreachable before the enum was removed.
  assert.deepStrictEqual(
    [...FAN_SPEEDS],
    ['auto', 'superQuiet', 'quiet', 'low', 'powerful', 'superPowerful'],
    'the vocabulary this test enumerates is still the one src ships',
  );
  for (const speed of FAN_SPEEDS) {
    assert.strictEqual(parseLocal({ fanSpeed: speed }).fanSpeed, speed, speed);
  }
});

test('local: an out-of-vocabulary fanSpeed throws instead of silently no-opping', () => {
  // 'high' and 'medium' are the retired coarse enum's values, and the most
  // likely thing for a stale caller to still be sending. The adapter would
  // answer 200 and ignore them, so this throw is the only signal that exists.
  for (const bogus of ['high', 'medium', 'Low', 'super powerful', '']) {
    assert.throws(
      () => parseLocal({ fanSpeed: bogus }),
      /Invalid fan speed/,
      `expected "${bogus}" to be rejected`,
    );
  }
});

test('local: fanSpeedRaw takes precedence over fanSpeed', () => {
  // Both set: the mirror push must reproduce the source unit faithfully, so the
  // raw string wins and the named one is not even consulted.
  const status = parseLocal({ fanSpeed: 'low', fanSpeedRaw: 'quiet' });
  assert.strictEqual(status.fanSpeed, 'quiet');
});

test('local: fanSpeedRaw is passed through unvalidated', () => {
  // The source unit reported it, so the hardware demonstrably produces it —
  // rejecting a speed this fork has not enumerated would break mirroring on any
  // model with a speed we have not seen. Deliberately NOT symmetric with the
  // named-fanSpeed throw above.
  const status = parseLocal({ fanSpeedRaw: 'someUnenumeratedSpeed' });
  assert.strictEqual(status.fanSpeed, 'someUnenumeratedSpeed');
});

test('cloud: toCloudCommands folds fanSpeedRaw into fanSpeed and drops fanSpeedRaw', () => {
  const wire = toCloudCommands({ operationMode: 'heat', spHeat: 21, fanSpeedRaw: 'powerful' });
  assert.deepStrictEqual(wire, { operationMode: 'heat', spHeat: 21, fanSpeed: 'powerful' });
});

test('cloud: toCloudCommands returns the input unchanged when there is no fanSpeedRaw', () => {
  const input = { operationMode: 'cool', spCool: 24 };
  assert.strictEqual(toCloudCommands(input), input);
});
