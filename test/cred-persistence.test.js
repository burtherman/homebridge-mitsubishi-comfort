'use strict';

// On-disk credential persistence (cred-store.ts + platform wiring).
//
// Motivation (2026-07-28, again): Front bedroom's fresh password arrived by push
// at 15:57 and worked for five hours — then two Homebridge restarts wiped the
// memory-only map, and the unit was back on cloud waiting for a push that takes
// hours. The store makes a captured credential survive restarts. Trust model is
// unchanged: stored entries are candidates, the signed discovery probe validates
// them, and a rotated password burns out after 3 attempts (shared budget with
// the legacy v2 path — the same stale password must not get a fresh budget by
// arriving from a different cache).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathmod = require('node:path');
const { KumoV3Platform } = require('../dist/platform.js');
const { loadCredStore, saveCredStore } = require('../dist/cred-store.js');

const A = 'SERIAL-A';
const B = 'SERIAL-B';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function makeApi(storageDir) {
  return {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => `uuid-${s}` } },
    platformAccessory: function PlatformAccessory() {},
    on: () => {},
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
    user: storageDir ? { storagePath: () => storageDir } : undefined,
  };
}

function makeKumoStub() {
  const stub = {
    passwords: new Map(),
    legacy: new Map(),
    legacyCalls: 0,
    requestAdapterStatus() {},
    getAdapterPassword(serial) {
      return stub.passwords.get(serial) || null;
    },
    async getDeviceCryptoSerial(serial) {
      return `crypto-${serial}`;
    },
    async fetchLegacyCredentials() {
      stub.legacyCalls += 1;
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

function makePlatform(storageDir) {
  const kumo = makeKumoStub();
  const platform = new KumoV3Platform(makeLog(), {
    name: 'test',
    platform: 'KumoV3',
    username: 'user@example.com',
    password: 'secret',
    disablePolling: true,
    localControl: true,
    localControlIps: { [A]: '192.168.1.10', [B]: '192.168.1.11' },
  }, makeApi(storageDir));
  platform.kumoAPI = kumo;
  platform.localClient = makeLocalClientStub();
  platform.localSerials = [A, B];
  platform.startLocalPolling = () => {};
  platform.initCredStore();
  return { platform, kumo };
}

function tmpdir() {
  return fs.mkdtempSync(pathmod.join(os.tmpdir(), 'kumo-creds-'));
}

// ---- store module ---------------------------------------------------------

test('store roundtrip preserves entries and writes mode 0600', () => {
  const dir = tmpdir();
  const file = pathmod.join(dir, 'creds.json');
  const m = new Map([[A, { password: 'pw', cryptoSerial: 'cs', capturedAt: '2026-07-28T00:00:00Z' }]]);
  saveCredStore(file, m, makeLog());

  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'store must not be world-readable');
  const back = loadCredStore(file, makeLog());
  assert.deepStrictEqual(back.get(A), { password: 'pw', cryptoSerial: 'cs', capturedAt: '2026-07-28T00:00:00Z' });
});

test('a corrupt store loads as empty instead of throwing', () => {
  const dir = tmpdir();
  const file = pathmod.join(dir, 'creds.json');
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(loadCredStore(file, makeLog()).size, 0);
});

// ---- the restart-survival scenario ---------------------------------------

test('a push-delivered credential survives a restart and is used without push or v2', async () => {
  const dir = tmpdir();

  // Process 1: the push delivers B's credential (the 15:57 event).
  {
    const { platform, kumo } = makePlatform(dir);
    kumo.passwords.set(B, 'push-pw-b');
    await platform.gatherLocalCreds([B], 10);
  }

  // Process 2 (post-restart): no push, no v2 — the store alone must fill it.
  {
    const { platform, kumo } = makePlatform(dir);
    const creds = await platform.gatherLocalCreds([B], 10);
    assert.strictEqual(creds.get(B)?.password, 'push-pw-b', 'stored credential should be used');
    assert.strictEqual(kumo.legacyCalls, 0, 'v2 must not be consulted when the store satisfies the gap');
  }
});

test('a probe-validated (v2-sourced) credential is persisted on admission', async () => {
  const dir = tmpdir();
  const { platform, kumo } = makePlatform(dir);
  kumo.legacy.set(A, { password: 'v2-pw-a', cryptoSerial: 'v2-cs-a' });

  // Admission via the manual-IP path exercises setCreds; the sweep path persists
  // via the probe-match loop. Simulate the sweep-validated case directly:
  const creds = await platform.gatherLocalCreds([A], 10);
  platform.persistCred(A, creds.get(A));

  const stored = loadCredStore(pathmod.join(dir, 'mitsubishi-comfort-local-creds.json'), makeLog());
  assert.strictEqual(stored.get(A)?.password, 'v2-pw-a');
});

test('a fresh push credential overwrites a stale stored one', async () => {
  const dir = tmpdir();
  {
    const { platform, kumo } = makePlatform(dir);
    kumo.passwords.set(B, 'old-pw');
    await platform.gatherLocalCreds([B], 10);
  }
  {
    const { platform, kumo } = makePlatform(dir);
    kumo.passwords.set(B, 'rotated-pw');   // adapter rotated; push delivers fresh
    const creds = await platform.gatherLocalCreds([B], 10);
    assert.strictEqual(creds.get(B)?.password, 'rotated-pw', 'push must beat the store');
    const stored = loadCredStore(pathmod.join(dir, 'mitsubishi-comfort-local-creds.json'), makeLog());
    assert.strictEqual(stored.get(B)?.password, 'rotated-pw', 'store must be updated to the fresh value');
  }
});

test('a stale stored credential is burned after 3 attempts and cannot re-enter from v2', async () => {
  const dir = tmpdir();
  {
    const { platform, kumo } = makePlatform(dir);
    kumo.passwords.set(B, 'stale-pw');
    await platform.gatherLocalCreds([B], 10);
  }
  {
    const { platform, kumo } = makePlatform(dir);
    // v2 holds the SAME stale password — the shared budget must apply across sources.
    kumo.legacy.set(B, { password: 'stale-pw', cryptoSerial: 'crypto-B' });
    for (let i = 1; i <= 3; i++) {
      const creds = await platform.gatherLocalCreds([B], 10);
      assert.strictEqual(creds.has(B), true, `attempt ${i} still tries the candidate`);
    }
    const fourth = await platform.gatherLocalCreds([B], 10);
    assert.strictEqual(fourth.has(B), false, 'burned across BOTH the store and v2');
  }
});

test('no storage dir -> store disabled, everything else works (existing-test compatibility)', async () => {
  const { platform, kumo } = makePlatform(null);
  kumo.passwords.set(A, 'pw-a');
  const creds = await platform.gatherLocalCreds([A], 10);
  assert.strictEqual(creds.get(A)?.password, 'pw-a');
});
