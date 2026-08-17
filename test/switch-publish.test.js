'use strict';

// Regression test for the runtime-switch-publish fix.
//
// The fan-only (1.4.0) and dry (1.5.0) switches are added from the async
// profile_update callback (applyDeviceProfile), AFTER the accessory has already
// been published to the bridge during discovery. A service added to an
// already-published accessory is invisible to HomeKit — and never persisted to
// cachedAccessories — unless the plugin calls
// api.updatePlatformAccessories([accessory]). It never did, so both switches
// silently failed to appear in the Home app.
//
// These tests drive the compiled accessory with a minimal HAP mock and assert
// that applying a capability profile both mutates the service set AND
// re-publishes the accessory. Before the fix, the publish count was 0.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// Stable characteristic identifiers (same object returned per name), with the
// nested state constants the accessory reads (e.g. CurrentHeatingCoolingState.OFF).
const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) {
      charCache[prop] = { _name: String(prop), OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 };
    }
    return charCache[prop];
  },
});

const Service = {
  AccessoryInformation: 'AccessoryInformation',
  Thermostat: 'Thermostat',
  Switch: 'Switch',
  FilterMaintenance: 'FilterMaintenance',
};

function makeCharacteristic() {
  const ch = {
    value: undefined,
    onGet() { return ch; },
    onSet() { return ch; },
    setProps() { return ch; },
  };
  return ch;
}

function makeService(type, name, subtype) {
  const chars = new Map();
  const svc = {
    type, name, subtype,
    getCharacteristic(id) {
      if (!chars.has(id)) chars.set(id, makeCharacteristic());
      return chars.get(id);
    },
    setCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    updateCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
  };
  return svc;
}

function makeAccessory() {
  // Pre-seed AccessoryInformation; the constructor uses getService(...)! on it.
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName: 'Living room',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Living room' } },
    getService(type) {
      const e = entries.find((x) => x.type === type && x.subtype === undefined);
      return e ? e.svc : null;
    },
    getServiceById(type, subtype) {
      const e = entries.find((x) => x.type === type && x.subtype === subtype);
      return e ? e.svc : null;
    },
    addService(type, name, subtype) {
      const svc = makeService(type, name, subtype);
      entries.push({ type, subtype, svc });
      return svc;
    },
    removeService(svc) {
      const i = entries.findIndex((x) => x.svc === svc);
      if (i >= 0) entries.splice(i, 1);
    },
  };
}

function makeHarness(log = makeLog()) {
  const updates = [];
  let profileCb = null;
  const platform = {
    Service,
    Characteristic,
    log,
    api: { updatePlatformAccessories: (a) => updates.push(a) },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, updates, applyProfile: (p) => profileCb(SERIAL, p) };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

const profile = (over = {}) => ({
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  hasModeVent: true,
  hasModeDry: true,
  ...over,
});

test('applying a vent+dry profile adds both switches and publishes them to HomeKit', () => {
  const { accessory, updates, applyProfile } = makeHarness();
  assert.strictEqual(updates.length, 0, 'nothing published before a profile arrives');

  applyProfile(profile());

  assert.ok(accessory.getServiceById(Service.Switch, 'fan-only'), 'fan-only switch added');
  assert.ok(accessory.getServiceById(Service.Switch, 'dry'), 'dry switch added');
  // The regression: before the fix this stayed 0 — services existed in memory
  // but were never pushed to the bridge.
  assert.ok(updates.length >= 1, 'accessory re-published after adding switches');
});

test('re-applying the same profile does not re-publish (guarded on real change)', () => {
  const { updates, applyProfile } = makeHarness();
  applyProfile(profile());
  const afterFirst = updates.length;
  applyProfile(profile());
  assert.strictEqual(updates.length, afterFirst, 'no redundant HomeKit config bump');
});

test('the temperature-range line is logged once, not on every profile heartbeat', () => {
  // profile_update is a ~15-min heartbeat carrying identical setpoint limits.
  // Logging "Set temperature range" each tick fills the log; it must only fire
  // when the range actually changes.
  const infos = [];
  const log = { info: (m) => infos.push(String(m)), warn() {}, error() {}, debug() {} };
  const { applyProfile } = makeHarness(log);
  const rangeLines = () => infos.filter((m) => /Set temperature range/.test(m)).length;

  applyProfile(profile());
  assert.strictEqual(rangeLines(), 1, 'logged once on the first profile');
  applyProfile(profile()); // identical heartbeat
  applyProfile(profile()); // identical heartbeat
  assert.strictEqual(rangeLines(), 1, 'repeated identical profiles do not re-log');

  // A genuinely different range logs again.
  applyProfile(profile({ maximumSetPoints: { cool: 30, heat: 30, auto: 30 } }));
  assert.strictEqual(rangeLines(), 2, 'a changed range re-logs exactly once');
});

test('dropping dry support removes the switch and publishes the removal', () => {
  const { accessory, updates, applyProfile } = makeHarness();
  applyProfile(profile());
  const before = updates.length;
  applyProfile(profile({ hasModeDry: false }));
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null, 'dry switch removed');
  assert.ok(updates.length > before, 'removal re-published to HomeKit');
});

// Same bug class as the switches: the humidity characteristic is added to the
// thermostat service the first time a humidity reading arrives — long after the
// accessory was published — so it must re-publish too.
test('first humidity reading publishes the humidity characteristic', () => {
  const { handler, updates } = makeHarness();
  const before = updates.length;
  handler.updateFromZone(zone({ humidity: 51 }));
  assert.ok(updates.length > before, 'adding humidity characteristic re-published the accessory');
});

test('humidity characteristic is published only once, not on every reading', () => {
  const { handler, updates } = makeHarness();
  handler.updateFromZone(zone({ humidity: 51 }));
  const after = updates.length;
  handler.updateFromZone(zone({ humidity: 52 }));
  assert.strictEqual(updates.length, after, 'no redundant publish once humidity is registered');
});
