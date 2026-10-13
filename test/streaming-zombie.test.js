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

// ---- an unanswered nudge is checked against the cloud's own copy (2.0) --------
//
// With every unit off and idle the adapters often don't answer a status nudge, so the
// detector reconnected 12-21 times a day from 2026-10-04 on with nothing wrong. Before
// reconnecting it now reads the cloud's REST copy of each unit and compares it with
// what the stream last delivered: a difference means the stream missed an update.

const SERIAL = '9X34P008S100095F';
const tick = () => new Promise((r) => setTimeout(r, 5));

function makeVerifyingApi(cloud) {
  const made = makeApi();
  const { api } = made;
  const warns = [];
  api.log = { info() {}, warn: (m) => warns.push(m), error() {}, debug() {} };
  api.knownSiteIds = new Set(['site-1']);
  let reads = 0;
  api.getZones = async (_site, opts) => {
    reads += 1;
    assert.deepStrictEqual(opts, { quiet: true }, 'the check must not dump zone JSON into the log');
    const adapter = typeof cloud === 'function' ? cloud() : cloud;
    return adapter ? [{ name: 'Kitchen', adapter: { deviceSerial: SERIAL, ...adapter } }] : [];
  };
  api.noteStreamState(SERIAL, { power: 0, operationMode: 'off', spHeat: 20, spCool: 22.5, roomTemp: 23.5 });
  // Quiet past PROBE_AFTER with the nudge's grace already run out.
  api.lastDeviceUpdateTs = Date.now() - 8 * MIN;
  api.probeBaselineDeviceTs = api.lastDeviceUpdateTs;
  api.probePendingSince = Date.now() - (GRACE_MS + 1000);
  return { ...made, warns, reads: () => reads };
}

test('unanswered nudge, cloud copy matches the stream: no reconnect, and the quiet clock restarts', async () => {
  const { api, reconnects, nudges, reads } = makeVerifyingApi(
    { power: 0, operationMode: 'off', spHeat: 20, spCool: 22.5, roomTemp: 23.5 });
  api.checkStreamingLiveness();
  await tick();
  assert.strictEqual(reads(), 1);
  assert.strictEqual(reconnects(), 0, 'an idle house must not reconnect');

  api.checkStreamingLiveness();                    // 30s later: still quiet, but just verified
  await tick();
  assert.strictEqual(nudges(), 0, 'no new nudge until another 5 quiet minutes');
  assert.strictEqual(reads(), 1);

  api.lastStreamVerifiedTs = Date.now() - 6 * MIN; // 5 more quiet minutes
  api.checkStreamingLiveness();
  assert.strictEqual(nudges(), 1, 'then it nudges again');
});

test('unanswered nudge, cloud copy differs from the stream: reconnect, saying what differs', async () => {
  const { api, reconnects, warns } = makeVerifyingApi(
    { power: 1, operationMode: 'heat', spHeat: 20, spCool: 22.5, roomTemp: 23.5 });
  api.checkStreamingLiveness();
  await tick();
  assert.strictEqual(reconnects(), 1);
  assert.strictEqual(api.forceStatusOnNextConnect, true);
  assert.ok(warns.some((m) => m.includes('Streaming zombie') && m.includes('the cloud has power=1 for Kitchen where the stream last sent 0')));
});

test('a new temperature the stream never delivered counts as missed', async () => {
  const { api, reconnects } = makeVerifyingApi(
    { power: 0, operationMode: 'off', spHeat: 20, spCool: 22.5, roomTemp: 24 });
  api.checkStreamingLiveness();
  await tick();
  assert.strictEqual(reconnects(), 1);
});

test('fields the cloud copy leaves out are not differences', async () => {
  const { api, reconnects } = makeVerifyingApi(
    { power: 0, operationMode: 'off', spHeat: null, roomTemp: 23.5 });
  api.checkStreamingLiveness();
  await tick();
  assert.strictEqual(reconnects(), 0);
});

test('if the cloud copy cannot be read it reconnects, as before', async () => {
  const { api, reconnects, warns } = makeVerifyingApi(null);
  api.checkStreamingLiveness();
  await tick();
  assert.strictEqual(reconnects(), 1);
  assert.ok(warns.some((m) => m.includes('couldn\'t be read')));
});

test('with nothing delivered by the stream yet there is nothing to compare, so it reconnects', async () => {
  const { api, reconnects } = makeVerifyingApi({ power: 0, operationMode: 'off' });
  api.streamState = new Map();
  api.checkStreamingLiveness();
  await tick();
  assert.strictEqual(reconnects(), 1);
});

test('only one check runs at a time', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, reads } = makeVerifyingApi({ power: 0, operationMode: 'off', roomTemp: 23.5 });
  const inner = api.getZones;
  api.getZones = async (...args) => { await gate; return inner(...args); };
  api.checkStreamingLiveness();
  api.probePendingSince = Date.now() - (GRACE_MS + 1000);   // the next tick would check again
  api.checkStreamingLiveness();
  release();
  await tick();
  assert.strictEqual(reads(), 1);
});

test('a partial device_update keeps the fields it does not carry', () => {
  const { api } = makeApi();
  api.noteStreamState(SERIAL, { power: 1, operationMode: 'heat', spHeat: 21, roomTemp: 20 });
  api.noteStreamState(SERIAL, { roomTemp: 20.5 });
  assert.deepStrictEqual(api.streamState.get(SERIAL), { power: 1, operationMode: 'heat', spHeat: 21, roomTemp: 20.5 });
});
