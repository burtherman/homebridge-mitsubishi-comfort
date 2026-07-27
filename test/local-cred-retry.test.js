'use strict';

// Regression tests for the background local-credential retry.
//
// The local password arrives only via the `adapter_update` socket event, and
// some adapters answer the nudge slowly (observed: 65s on a healthy unit) or not
// at all until they recover from a wedged cloud session. The original
// initLocalControl waited a fixed 25s and then gave up forever, silently
// stranding those units on the cloud for the life of the process.

const test = require('node:test');
const assert = require('node:assert');
const { KumoV3Platform } = require('../dist/platform.js');

const A = 'SERIAL-A';
const B = 'SERIAL-B';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function makeApi() {
  return {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => `uuid-${s}` } },
    platformAccessory: function PlatformAccessory() {},
    on: () => {},
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
}

/** Stub KumoAPI whose adapter passwords appear only when the test says so. */
function makeKumoStub() {
  const stub = {
    passwords: new Map(),
    nudges: [],
    requestAdapterStatus(serial) {
      stub.nudges.push(serial);
    },
    getAdapterPassword(serial) {
      return stub.passwords.get(serial) || null;
    },
    async getDeviceCryptoSerial(serial) {
      return `crypto-${serial}`;
    },
    destroy() {},
  };
  return stub;
}

function makeLocalClientStub() {
  const creds = new Map();
  return {
    creds,
    setCreds(serial, c) {
      creds.set(serial, c);
    },
    hasLocal(serial) {
      return creds.has(serial);
    },
    async getStatus() {
      return null;
    },
  };
}

/**
 * A platform wired for local control over two devices, both with configured IPs
 * so admitLocalDevices takes the manual path and never sweeps the LAN.
 */
function makePlatform() {
  const kumo = makeKumoStub();
  const platform = new KumoV3Platform(makeLog(), {
    name: 'test',
    platform: 'KumoV3',
    username: 'user@example.com',
    password: 'secret',
    disablePolling: true,
    localControl: true,
    localControlIps: { [A]: '192.168.1.10', [B]: '192.168.1.11' },
  }, makeApi());
  platform.kumoAPI = kumo;
  platform.localClient = makeLocalClientStub();
  platform.localSerials = [A, B];
  // Local polling is out of scope here — keep the test free of timers.
  platform.startLocalPolling = () => {};
  return { platform, kumo };
}

test('gatherLocalCreds only returns devices that produced both halves of the key', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'pw-a');

  const creds = await platform.gatherLocalCreds([A, B], 50);

  assert.deepStrictEqual([...creds.keys()], [A]);
  assert.deepStrictEqual(creds.get(A), { password: 'pw-a', cryptoSerial: `crypto-${A}` });
  assert.ok(kumo.nudges.includes(B), 'the straggler should still get nudged');
});

test('a device that answers after the initial window is admitted by the retry', async () => {
  const { platform, kumo } = makePlatform();

  // Initial pass: only A answers, B is stranded.
  kumo.passwords.set(A, 'pw-a');
  await platform.admitLocalDevices(await platform.gatherLocalCreds([A, B], 50));
  assert.strictEqual(platform.localClient.hasLocal(A), true);
  assert.strictEqual(platform.localClient.hasLocal(B), false);
  assert.deepStrictEqual(platform.pendingLocalSerials(), [B]);

  // B's adapter finally answers the nudge.
  kumo.passwords.set(B, 'pw-b');
  await platform.retryLocalCreds();

  assert.strictEqual(platform.localClient.hasLocal(B), true, 'B should now be on local control');
  assert.strictEqual(platform.localClient.creds.get(B).ip, '192.168.1.11');
  assert.strictEqual(platform.countLocalDevices(), 2);
});

test('the retry only re-nudges devices that are still missing', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'pw-a');
  await platform.admitLocalDevices(await platform.gatherLocalCreds([A, B], 50));

  kumo.nudges.length = 0;
  await platform.retryLocalCreds();

  assert.ok(kumo.nudges.length > 0);
  assert.ok(!kumo.nudges.includes(A), 'A is already local — no need to nudge it again');
  assert.ok(kumo.nudges.includes(B));
});

test('the retry timer stops once every device is local', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'pw-a');
  kumo.passwords.set(B, 'pw-b');

  platform.scheduleLocalCredRetry();
  assert.ok(platform.localCredRetryTimer, 'a retry should be scheduled while devices are pending');

  await platform.retryLocalCreds();

  assert.strictEqual(platform.countLocalDevices(), 2);
  assert.strictEqual(platform.localCredRetryTimer, null, 'retry should stop when nothing is pending');
});

test('scheduleLocalCredRetry is a no-op when every device is already local', async () => {
  const { platform } = makePlatform();
  platform.localClient.setCreds(A, { ip: '1', password: 'p', cryptoSerial: 'c' });
  platform.localClient.setCreds(B, { ip: '2', password: 'p', cryptoSerial: 'c' });

  platform.scheduleLocalCredRetry();

  assert.strictEqual(platform.localCredRetryTimer, null);
});

test('overlapping retry passes are suppressed', async () => {
  const { platform, kumo } = makePlatform();
  let gathers = 0;
  platform.gatherLocalCreds = async () => {
    gathers++;
    await new Promise((r) => setTimeout(r, 30));
    return new Map();
  };

  const first = platform.retryLocalCreds();
  await platform.retryLocalCreds(); // fires while the first pass is mid-sweep
  await first;

  assert.strictEqual(gathers, 1, 'the second pass should bail out rather than double-sweep');
  assert.strictEqual(kumo.nudges.length, 0);
});

test('cleanup clears the retry timer', async () => {
  const { platform } = makePlatform();
  platform.scheduleLocalCredRetry();
  assert.ok(platform.localCredRetryTimer);

  platform.cleanup();

  assert.strictEqual(platform.localCredRetryTimer, null);
});
