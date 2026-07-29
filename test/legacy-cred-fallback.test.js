'use strict';

// Legacy v2 credential fallback (fillFromLegacyCreds / fetchLegacyCredentials).
//
// Motivation (2026-07-28): the Living room's `adapter_update` push never arrived
// — hours of nudging, zero deliveries — stranding a reachable, healthy unit on
// cloud control. The legacy v2 cloud API still returns every adapter's local
// password + cryptoSerial via plain REST (verified live: v2 creds signed a
// successful local status read against that exact unit). The same verification
// also found the sharp edge: the v2 store can be STALE (a rotated password got
// `device_authentication_error`), so push creds must always win and stale
// candidates must not cause a LAN sweep every retry cycle forever.

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

/** Stub KumoAPI: socket-push passwords AND a configurable legacy v2 store. */
function makeKumoStub() {
  const stub = {
    passwords: new Map(),
    legacy: new Map(),
    legacyCalls: 0,
    legacyThrows: false,
    requestAdapterStatus() {},
    getAdapterPassword(serial) {
      return stub.passwords.get(serial) || null;
    },
    async getDeviceCryptoSerial(serial) {
      return `crypto-${serial}`;
    },
    async fetchLegacyCredentials() {
      stub.legacyCalls += 1;
      if (stub.legacyThrows) {
        throw new Error('v2 endpoint down');
      }
      return stub.legacy;
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
  platform.startLocalPolling = () => {};
  return { platform, kumo };
}

test('a straggler the push never credentialed is filled from the v2 store and admitted', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'push-pw-a');
  // v2 knows BOTH units — including a (different) copy for A.
  kumo.legacy.set(A, { password: 'v2-pw-a', cryptoSerial: 'v2-cs-a' });
  kumo.legacy.set(B, { password: 'v2-pw-b', cryptoSerial: 'v2-cs-b' });

  const creds = await platform.gatherLocalCreds([A, B], 50);
  await platform.admitLocalDevices(creds);

  assert.strictEqual(platform.localClient.hasLocal(B), true, 'B should be admitted via v2 creds');
  assert.strictEqual(platform.localClient.creds.get(B).password, 'v2-pw-b');
  // Push creds always win — v2's copy of A must NOT clobber the fresh push copy.
  assert.strictEqual(platform.localClient.creds.get(A).password, 'push-pw-a',
    'the socket-push credential must take precedence over the v2 copy');
});

test('no legacy fetch happens at all when the push delivered everything', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'push-pw-a');
  kumo.passwords.set(B, 'push-pw-b');

  await platform.gatherLocalCreds([A, B], 50);

  assert.strictEqual(kumo.legacyCalls, 0, 'v2 must only be consulted for gaps');
});

test('the same stale v2 password is handed out at most 3 times, then burned', async () => {
  const { platform, kumo } = makePlatform();
  kumo.legacy.set(B, { password: 'stale-pw', cryptoSerial: 'cs-b' });

  // Simulates the minute-cadence retry loop hitting an invalid v2 credential:
  // attempts 1-3 hand it to discovery, attempt 4+ must skip it.
  for (let i = 1; i <= 3; i++) {
    const creds = await platform.gatherLocalCreds([B], 10);
    assert.strictEqual(creds.has(B), true, `attempt ${i} should still try the v2 credential`);
  }
  const fourth = await platform.gatherLocalCreds([B], 10);
  assert.strictEqual(fourth.has(B), false, 'a thrice-failed password must be burned');
});

test('a rotated v2 password resets the attempt budget', async () => {
  const { platform, kumo } = makePlatform();
  kumo.legacy.set(B, { password: 'stale-pw', cryptoSerial: 'cs-b' });
  for (let i = 0; i < 3; i++) {
    await platform.gatherLocalCreds([B], 10);
  }
  assert.strictEqual((await platform.gatherLocalCreds([B], 10)).has(B), false, 'burned');

  // The v2 store rotates (e.g. the adapter re-paired) — the new password gets a
  // fresh budget.
  kumo.legacy.set(B, { password: 'fresh-pw', cryptoSerial: 'cs-b' });
  const creds = await platform.gatherLocalCreds([B], 10);
  assert.strictEqual(creds.has(B), true, 'a new password deserves a new attempt budget');
  assert.strictEqual(creds.get(B).password, 'fresh-pw');
});

test('a dead v2 endpoint is non-fatal: push-only behavior is unchanged', async () => {
  const { platform, kumo } = makePlatform();
  kumo.passwords.set(A, 'push-pw-a');
  kumo.legacyThrows = true;

  const creds = await platform.gatherLocalCreds([A, B], 50);

  assert.deepStrictEqual([...creds.keys()], [A], 'A via push; B simply stays missing');
});
