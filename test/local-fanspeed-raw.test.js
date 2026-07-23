'use strict';

// Fan-speed raw passthrough for the mirror path.
//
// The coarse `fanSpeed` enum (auto/low/medium/high) and the adapter's local
// vocabulary (auto/quiet/low/powerful/...) overlap in strings with DIFFERENT
// meanings (coarse 'low' → local 'quiet'; coarse 'medium' → local 'low'). So a
// mirrored raw speed must bypass the coarse mapper and be written verbatim.

const test = require('node:test');
const assert = require('node:assert');
const { buildLocalCommandBody } = require('../dist/local-api.js');
const { toCloudCommands } = require('../dist/kumo-api.js');

const parseLocal = (commands) =>
  JSON.parse(buildLocalCommandBody(commands).toString('utf8')).c.indoorUnit.status;

test('local: fanSpeedRaw is written verbatim to status.fanSpeed', () => {
  const status = parseLocal({ operationMode: 'heat', spHeat: 21, fanSpeedRaw: 'powerful' });
  assert.strictEqual(status.fanSpeed, 'powerful');
  assert.strictEqual(status.mode, 'heat');
});

test('local: coarse fanSpeed still maps through the enum for the switch paths', () => {
  const status = parseLocal({ fanSpeed: 'high' });
  assert.strictEqual(status.fanSpeed, 'powerful'); // coarse high → local powerful
});

test('local: fanSpeedRaw takes precedence over a coarse fanSpeed', () => {
  const status = parseLocal({ fanSpeed: 'high', fanSpeedRaw: 'quiet' });
  assert.strictEqual(status.fanSpeed, 'quiet');
});

test('cloud: toCloudCommands folds fanSpeedRaw into fanSpeed and drops fanSpeedRaw', () => {
  const wire = toCloudCommands({ operationMode: 'heat', spHeat: 21, fanSpeedRaw: 'powerful' });
  assert.deepStrictEqual(wire, { operationMode: 'heat', spHeat: 21, fanSpeed: 'powerful' });
});

test('cloud: toCloudCommands returns the input unchanged when there is no fanSpeedRaw', () => {
  const input = { operationMode: 'cool', spCool: 24 };
  assert.strictEqual(toCloudCommands(input), input);
});
