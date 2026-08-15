'use strict';

// Unit tests for the streaming "zombie" detector (src/kumo-api.ts:checkStreamingLiveness).
//
// A zombie stream = the socket stays TCP-connected (so checkStreamingHealth() still
// reports "healthy") while its device_update subscription silently dies. Observed live
// 2026-08-15: device_update went dead for 13 min while profile_update kept arriving on
// its normal ~2–4 min heartbeat, and nothing auto-recovered.
//
// Because the cloud only sends device_update on real state change, a long silence is
// ambiguous (idle vs zombie). The detector disambiguates with an ACTIVE nudge and only
// reconnects if NO device answers — the property under test, so it never repeats the
// removed probe's false-firing on a quiet-but-healthy stream.

const test = require('node:test');
const assert = require('node:assert');
const { KumoAPI } = require('../dist/kumo-api.js');

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };
const MIN = 60000;
const GRACE_MS = 150000; // must match KumoAPI.PROBE_GRACE_MS

function makeApi({ connected = true, reconnecting = false } = {}) {
  const api = new KumoAPI('user@example.com', 'pw', NOOP_LOG, false, true);
  let reconnects = 0;
  let nudges = 0;
  api.isStreamingConnected = () => connected;
  api.reconnectStreaming = async () => { reconnects += 1; };
  api.isReconnecting = reconnecting;
  // nudgeDeviceStatus() iterates deviceUpdateCallbacks and emits on the socket.
  api.deviceUpdateCallbacks = new Map([['9X34P008S100095F', () => {}]]);
  api.socket = { emit: () => { nudges += 1; } };
  return { api, reconnects: () => reconnects, nudges: () => nudges };
}

test('idle stream: nudge is sent, a device answers, NO reconnect (anti-false-fire)', () => {
  const { api, reconnects, nudges } = makeApi();
  api.lastDeviceUpdateTs = Date.now() - 6 * MIN; // quiet past PROBE_AFTER (5 min)

  api.checkStreamingLiveness();                    // tick 1 → nudge
  assert.strictEqual(nudges(), 1, 'should nudge once when quiet');
  assert.ok(api.probePendingSince > 0, 'probe should be pending');
  assert.strictEqual(reconnects(), 0);

  api.lastDeviceUpdateTs = Date.now();             // a device_update answers the nudge
  api.checkStreamingLiveness();                    // tick 2 → clears, no reconnect
  assert.strictEqual(reconnects(), 0, 'a healthy idle stream must never reconnect');
  assert.strictEqual(api.probePendingSince, 0, 'probe cleared once device answered');
});

test('zombie stream: nudge goes unanswered through the grace window → reconnect', () => {
  const { api, reconnects, nudges } = makeApi();
  api.lastDeviceUpdateTs = Date.now() - 6 * MIN;

  api.checkStreamingLiveness();                    // tick 1 → nudge
  assert.strictEqual(nudges(), 1);
  assert.strictEqual(reconnects(), 0, 'must wait out the grace before reconnecting');

  // Simulate the full grace elapsing with NO device_update (lastDeviceUpdateTs unchanged).
  api.probePendingSince = Date.now() - (GRACE_MS + 1000);
  api.checkStreamingLiveness();                    // tick 2 → zombie confirmed
  assert.strictEqual(reconnects(), 1, 'an unanswered nudge is a real zombie → reconnect');
  assert.strictEqual(api.forceStatusOnNextConnect, true,
    'reconnect must re-request status so device_update resumes');
  assert.strictEqual(nudges(), 1, 'only the single probe nudge, no extra churn');
});

test('healthy stream (device_update flowing) neither nudges nor reconnects', () => {
  const { api, reconnects, nudges } = makeApi();
  api.lastDeviceUpdateTs = Date.now() - 1 * MIN; // within PROBE_AFTER
  api.checkStreamingLiveness();
  assert.strictEqual(nudges(), 0);
  assert.strictEqual(reconnects(), 0);
});

test('fresh connection (unseeded clock) is ignored', () => {
  const { api, reconnects, nudges } = makeApi();
  api.lastDeviceUpdateTs = 0;
  api.checkStreamingLiveness();
  assert.strictEqual(nudges(), 0);
  assert.strictEqual(reconnects(), 0);
});

test('a disconnected socket abandons any in-flight probe (Socket.IO handles reconnect)', () => {
  const { api, reconnects, nudges } = makeApi({ connected: false });
  api.lastDeviceUpdateTs = Date.now() - 6 * MIN;
  api.probePendingSince = Date.now() - (GRACE_MS + 1000);
  api.checkStreamingLiveness();
  assert.strictEqual(reconnects(), 0);
  assert.strictEqual(nudges(), 0);
  assert.strictEqual(api.probePendingSince, 0, 'probe abandoned while disconnected');
});

test('an in-progress planned reconnect suppresses the liveness check', () => {
  const { api, reconnects, nudges } = makeApi({ reconnecting: true });
  api.lastDeviceUpdateTs = Date.now() - 6 * MIN;
  api.checkStreamingLiveness();
  assert.strictEqual(reconnects(), 0);
  assert.strictEqual(nudges(), 0);
});

test('cooldown blocks starting a fresh probe right after a reconnect', () => {
  const { api, reconnects, nudges } = makeApi();
  api.lastDeviceUpdateTs = Date.now() - 6 * MIN;
  api.lastZombieReconnectTs = Date.now() - 1 * MIN; // reconnected 1 min ago (< 5 min cooldown)
  api.checkStreamingLiveness();
  assert.strictEqual(nudges(), 0, 'no probe within the cooldown');
  assert.strictEqual(reconnects(), 0);
});
