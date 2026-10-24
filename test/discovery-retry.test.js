'use strict';

// Regression tests for the discovery self-heal added in v1.4.1.
// Before the fix, a transient login/network failure at startup left the plugin
// idle until a manual restart, and a transient empty zones response could
// unregister every cached accessory. These tests exercise that logic against
// the compiled platform with the KumoAPI replaced by a stub (no network).

const test = require('node:test');
const assert = require('node:assert');
const { KumoV3Platform } = require('../dist/platform.js');

const SERIAL = 'TESTSERIAL001';
const SITE = { id: 'site-1', name: 'Home' };
const ZONE = { isActive: true, name: 'Living room', adapter: { deviceSerial: SERIAL } };

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function makeApi(spies) {
  return {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: { generate: (s) => `uuid-${s}` },
    },
    platformAccessory: function PlatformAccessory(displayName, uuid) {
      this.displayName = displayName;
      this.UUID = uuid;
      this.context = {};
    },
    on: () => {},
    registerPlatformAccessories: (...a) => spies.register.push(a),
    updatePlatformAccessories: (...a) => spies.update.push(a),
    unregisterPlatformAccessories: (...a) => spies.unregister.push(a),
  };
}

function makePlatform(kumoStub, configOverrides = {}) {
  const spies = { register: [], update: [], unregister: [] };
  const config = {
    name: 'test',
    platform: 'KumoV3',
    username: 'user@example.com',
    password: 'secret',
    disablePolling: true,
    ...configOverrides,
  };
  const platform = new KumoV3Platform(makeLog(), config, makeApi(spies));
  // Swap the real API (constructed in the ctor, harmless) for our stub.
  platform.kumoAPI = kumoStub;
  return { platform, spies };
}

function stopRetries(platform) {
  platform.discoverDevices = async () => {};
  if (platform.discoveryRetryTimer) {
    clearTimeout(platform.discoveryRetryTimer);
    platform.discoveryRetryTimer = null;
  }
}

test('login failure schedules a retry instead of giving up', async () => {
  let loginCalls = 0;
  const stub = {
    login: async () => { loginCalls++; return false; },
    getSites: async () => { throw new Error('should not reach getSites'); },
    destroy: () => {},
  };
  const { platform, spies } = makePlatform(stub);
  try {
    await platform.discoverDevices();
    assert.strictEqual(loginCalls, 1, 'login attempted once');
    assert.ok(platform.discoveryRetryTimer !== null, 'a retry timer is scheduled');
    assert.strictEqual(spies.register.length, 0, 'no accessories registered on failure');
  } finally {
    stopRetries(platform);
  }
});

test('retry actually re-invokes discovery after the backoff', async () => {
  let sitesCalls = 0;
  const stub = {
    login: async () => true,
    getSites: async () => { sitesCalls++; return []; }, // "no sites" -> retry
    destroy: () => {},
  };
  const { platform } = makePlatform(stub);
  platform.discoveryRetryDelayMs = 20; // shrink backoff for the test
  try {
    await platform.discoverDevices();
    await new Promise((r) => setTimeout(r, 130));
    assert.ok(sitesCalls >= 2, `discovery re-fired (getSites called ${sitesCalls}x)`);
  } finally {
    stopRetries(platform);
  }
});

test('successful discovery clears the retry timer and resets backoff', async () => {
  const stub = {
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [ZONE],
    startStreaming: async () => true,
    onDeviceConnectionStatusChange: () => {},
    destroy: () => {},
  };
  const { platform } = makePlatform(stub);
  // Pre-seed a handler so the idempotency guard skips real accessory construction.
  platform.accessoryHandlers = [{ getDeviceSerial: () => SERIAL, getSiteId: () => SITE.id, destroy: () => {} }];
  platform.discoveryRetryDelayMs = 99999; // pretend we had backed off
  try {
    await platform.discoverDevices();
    assert.strictEqual(platform.discoveryRetryTimer, null, 'no retry scheduled on success');
    assert.strictEqual(platform.discoveryRetryDelayMs, platform.discoveryRetryBaseMs, 'backoff reset');
  } finally {
    stopRetries(platform);
  }
});

test('idempotent: an already-handled device is not re-registered', async () => {
  const stub = {
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [ZONE],
    startStreaming: async () => true,
    onDeviceConnectionStatusChange: () => {},
    destroy: () => {},
  };
  const { platform, spies } = makePlatform(stub);
  platform.accessoryHandlers = [{ getDeviceSerial: () => SERIAL, getSiteId: () => SITE.id, destroy: () => {} }];
  try {
    await platform.discoverDevices();
    assert.strictEqual(spies.register.length, 0, 'existing handler -> no duplicate registration');
    assert.strictEqual(platform.discoveryRetryTimer, null, 'discovery treated as success');
  } finally {
    stopRetries(platform);
  }
});

test('transient empty zones does NOT unregister cached accessories', async () => {
  const stub = {
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [], // transient failure returns no zones
    startStreaming: async () => true,
    onDeviceConnectionStatusChange: () => {},
    destroy: () => {},
  };
  const { platform, spies } = makePlatform(stub);
  // A cached accessory that would have been wiped by the old "stale" sweep.
  platform.accessories = [{ UUID: 'uuid-OTHER', displayName: 'Cached', context: {} }];
  try {
    await platform.discoverDevices();
    assert.strictEqual(spies.unregister.length, 0, 'cached accessories preserved on transient empty result');
    assert.ok(platform.discoveryRetryTimer !== null, 'empty result triggers a retry');
  } finally {
    stopRetries(platform);
  }
});

// 2.0 replaces each 1.x accessory instead of swapping its Thermostat for a
// HeaterCooler in place (iOS draws an in-place-migrated tile as a switch;
// reproduced on a test bridge 2026-10-23). Runs the real handler, so it uses the
// HAP fakes from helpers.
test('upgrade: the old accessory is replaced by a new identity, keeping the power-on mode', async () => {
  const { Service, Characteristic, makeAccessory } = require('./helpers');
  const spies = { register: [], update: [], unregister: [] };
  const warnings = [];
  const api = makeApi(spies);
  api.hap.Service = Service;
  api.hap.Characteristic = Characteristic;
  api.platformAccessory = function PlatformAccessory(displayName, uuid) {
    const acc = makeAccessory(displayName, SERIAL);
    acc.UUID = uuid;
    acc.context = {};
    return acc;
  };
  const config = {
    name: 'test', platform: 'KumoV3', username: 'user@example.com', password: 'secret',
    disablePolling: true,
  };
  const log = { ...makeLog(), warn: (m) => warnings.push(m) };
  const platform = new KumoV3Platform(log, config, api);
  // Any KumoAPI call the handler or discovery makes is a harmless no-op.
  platform.kumoAPI = new Proxy({
    login: async () => true,
    getSites: async () => [SITE],
    getZones: async () => [ZONE],
    startStreaming: async () => true,
  }, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const old = { UUID: `uuid-${SERIAL}`, displayName: 'Living room', context: { lastActiveMode: 'heat' } };
  platform.accessories = [old];
  try {
    await platform.discoverDevices();
    const [[, , [added]]] = spies.register;
    assert.strictEqual(added.UUID, `uuid-${SERIAL}:heatercooler`, 'new identity');
    assert.strictEqual(added.context.lastActiveMode, 'heat', 'power-on mode carried over');
    assert.deepStrictEqual(spies.unregister.map(([, , accs]) => accs.map(a => a.UUID)), [[old.UUID]],
      'the old accessory is retired');
    assert.ok(warnings.some((m) => /replaced the old accessory/.test(m)), 'the owner is told what to redo');
  } finally {
    stopRetries(platform);
    for (const h of platform.accessoryHandlers) {
      h.destroy?.();
    }
    platform.kumoAPI = { destroy: () => {} };
  }
});
