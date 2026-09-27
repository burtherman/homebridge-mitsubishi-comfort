'use strict';

// Vane (louver) writes at both command boundaries.
//
// The local field is `vaneDir`, the cloud calls the same thing `airDirection`.
// Neither the adapter nor (as far as anyone has observed) the cloud validates the
// value: a bad direction is accepted and silently ignored, so buildLocalCommandBody
// and toCloudCommands are the only places a typo can be caught. Both must throw,
// because sendDeviceCommand falls back from local to cloud on a local failure.

const test = require('node:test');
const assert = require('node:assert');
const { buildLocalCommandBody } = require('../dist/local-api.js');
const { toCloudCommands } = require('../dist/kumo-api.js');
const { VANE_DIRECTIONS } = require('../dist/settings.js');

const parseLocal = (commands) => JSON.parse(buildLocalCommandBody(commands).toString('utf8')).c.indoorUnit.status;

test('local: every vane direction is written verbatim as vaneDir', () => {
  for (const dir of VANE_DIRECTIONS) {
    assert.strictEqual(parseLocal({ vaneDir: dir }).vaneDir, dir, dir);
  }
});

test('local: an out-of-vocabulary vane direction throws', () => {
  for (const bogus of ['notARealVane', 'Swing', 'mid', '']) {
    assert.throws(() => parseLocal({ vaneDir: bogus }), /Invalid vane direction/, bogus);
  }
});

test('cloud: vaneDir becomes airDirection and is not sent under the local name', () => {
  const wire = toCloudCommands({ operationMode: 'cool', vaneDir: 'swing' });
  assert.deepStrictEqual(wire, { operationMode: 'cool', airDirection: 'swing' });
});

test('cloud: an out-of-vocabulary vane direction throws', () => {
  assert.throws(() => toCloudCommands({ vaneDir: 'notARealVane' }), /Invalid vane direction/);
});

test('cloud: the mirror fan passthrough still folds into fanSpeed alongside a vane', () => {
  const wire = toCloudCommands({ fanSpeedRaw: 'quiet', vaneDir: 'vertical' });
  assert.deepStrictEqual(wire, { fanSpeed: 'quiet', airDirection: 'vertical' });
});

test('cloud: commands with nothing to translate pass through unchanged', () => {
  const commands = { operationMode: 'heat', spHeat: 21 };
  assert.strictEqual(toCloudCommands(commands), commands);
});
