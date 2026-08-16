'use strict';

// Unit tests for sustained-failure logging (src/local-api.ts noteLocalFail/noteLocalOk).
//
// Local reads flap `device_authentication_error` for a single poll and self-recover on
// the next — harmless, but noisy if every blip logs "failing"/"recovered". Only a
// SUSTAINED run (>= VISIBLE_FAIL_THRESHOLD consecutive failures = a unit that's really
// gone) should surface at the visible level. These drive the private note* methods
// directly with a log spy.

const test = require('node:test');
const assert = require('node:assert');
const { LocalKumoClient } = require('../dist/local-api.js');

function spyClient() {
  const infos = [];
  const log = { info: (m) => infos.push(String(m)), warn() {}, error() {}, debug() {} };
  // debugMode = true so visible lines route to log.info (the plugin's `debug` flag).
  return { client: new LocalKumoClient(log, 6000, true), infos };
}

test('a single failed read that recovers logs nothing visible', () => {
  const { client, infos } = spyClient();
  client.noteLocalFail('S', '1.2.3.4', 'api error device_authentication_error');
  client.noteLocalOk('S');
  assert.strictEqual(infos.length, 0, 'a one-poll blip must not surface');
});

test('two consecutive failures still stay quiet (below threshold)', () => {
  const { client, infos } = spyClient();
  client.noteLocalFail('S', '1.2.3.4', 'auth');
  client.noteLocalFail('S', '1.2.3.4', 'auth');
  assert.strictEqual(infos.length, 0);
});

test('the third consecutive failure surfaces once, and recovery surfaces once', () => {
  const { client, infos } = spyClient();
  client.noteLocalFail('S', '1.2.3.4', 'auth');
  client.noteLocalFail('S', '1.2.3.4', 'auth');
  client.noteLocalFail('S', '1.2.3.4', 'auth'); // hits threshold (3)
  client.noteLocalFail('S', '1.2.3.4', 'auth'); // beyond threshold → debug only
  assert.strictEqual(infos.filter(m => /failing/.test(m)).length, 1, 'exactly one "failing" line');
  client.noteLocalOk('S');
  assert.strictEqual(infos.filter(m => /recovered/.test(m)).length, 1, 'one "recovered" line');
});

test('the failure counter resets after recovery, so the next blip is quiet again', () => {
  const { client, infos } = spyClient();
  for (let i = 0; i < 4; i++) client.noteLocalFail('S', '1.2.3.4', 'auth'); // surfaces
  client.noteLocalOk('S'); // recovers, resets
  infos.length = 0;
  client.noteLocalFail('S', '1.2.3.4', 'auth'); // fresh blip
  client.noteLocalOk('S');
  assert.strictEqual(infos.length, 0, 'a blip after a recovered run is quiet again');
});
