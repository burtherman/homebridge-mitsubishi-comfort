'use strict';

// A bad platform config must leave the plugin idle, not throw.
//
// Homebridge constructs platforms without a try/catch, so a throw in the constructor
// stops the whole Homebridge process (every other plugin with it), and the service
// restarts straight back into the same error. Before 1.10.3 a bare
// {"platform": "KumoV3"} did exactly that, which is also one of the runtime scenarios
// the Homebridge verification bot runs ("platform only", expects Homebridge to start).

const test = require('node:test');
const assert = require('node:assert');
const { KumoV3Platform, validateConfig } = require('../dist/platform.js');

function makeLog() {
  const errors = [];
  const noop = () => {};
  return { log: { info: noop, warn: noop, debug: noop, error: (m) => errors.push(m) }, errors };
}

function makeApi() {
  const events = [];
  return {
    events,
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => `uuid-${s}` } },
    platformAccessory: function PlatformAccessory() {},
    on: (event) => events.push(event),
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
}

const VALID = { platform: 'KumoV3', name: 'Kumo', username: 'user@example.com', password: 'secret' };

test('validateConfig accepts a valid config', () => {
  assert.strictEqual(validateConfig(VALID), null);
  assert.strictEqual(validateConfig({ ...VALID, pollInterval: 5 }), null);
});

test('validateConfig names the problem for each bad config', () => {
  assert.match(validateConfig({ platform: 'KumoV3' }), /Username and password are required/);
  assert.match(validateConfig({ ...VALID, password: undefined }), /Username and password are required/);
  assert.match(validateConfig({ ...VALID, username: 'not-an-email' }), /email address/);
  assert.match(validateConfig({ ...VALID, password: '   ' }), /non-empty/);
  assert.match(validateConfig({ ...VALID, pollInterval: 1 }), /at least 5 seconds/);
  assert.match(validateConfig({ ...VALID, pollInterval: '30' }), /at least 5 seconds/);
});

test('a bare {"platform": "KumoV3"} does not throw: one error, and the plugin stays idle', () => {
  const { log, errors } = makeLog();
  const api = makeApi();
  assert.doesNotThrow(() => new KumoV3Platform(log, { platform: 'KumoV3' }, api));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /Config error: Username and password are required\. The plugin is idle/);
  assert.deepStrictEqual(api.events, [], 'an idle platform must not register launch/shutdown handlers');
});

test('every bad config leaves the platform constructed and idle', () => {
  for (const bad of [{ ...VALID, username: 'nope' }, { ...VALID, password: '' }, { ...VALID, pollInterval: 2 }]) {
    const { log, errors } = makeLog();
    const api = makeApi();
    assert.doesNotThrow(() => new KumoV3Platform(log, bad, api));
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(api.events, []);
  }
});

test('a cached accessory can still be handed to an idle platform', () => {
  const { log } = makeLog();
  const platform = new KumoV3Platform(log, { platform: 'KumoV3' }, makeApi());
  assert.doesNotThrow(() => platform.configureAccessory({ displayName: 'Kitchen' }));
  assert.strictEqual(platform.accessories.length, 1);
});

test('a valid config still starts normally', () => {
  const { log, errors } = makeLog();
  const api = makeApi();
  new KumoV3Platform(log, VALID, api);
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(api.events.sort(), ['didFinishLaunching', 'shutdown']);
});
