'use strict';

// Regression test for the dry-mode setpoint field bug.
//
// On the Kumo v3 cloud, Dry mode holds its temperature setpoint in `spCool`
// (there is no spDry field). The old code routed dry through the catch-all
// `else` branch that writes/reads `spHeat`, so dry-mode temperature changes
// silently did nothing — the cloud accepted the spHeat write but the unit
// ignored it (and some writes 400'd with `invalidSpHeatRange`). Live-confirmed
// against the real account: a unit in dry reports e.g. spCool=25, spHeat=23, and
// the plugin surfaced 23 (the wrong field). Writing spCool while in dry is
// adopted and the unit stays in dry.
//
// The fix routes dry to spCool in both setTargetTemperature (write) and
// getTargetTempFromStatus (read), gated on the device profile's
// `usesSetPointInDryMode` flag — but defaulting to "has a setpoint" until the
// async profile arrives, so the common case works immediately.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

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
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName: 'Kitchen',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Kitchen' } },
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

function makeHarness() {
  const sendCommandCalls = [];
  let profileCb = null;
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand(serial, commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, sendCommandCalls, applyProfile: (p) => profileCb(SERIAL, p) };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'dry',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 25, spHeat: 23, spAuto: null, humidity: null,
    ...over,
  },
});

const profile = (over = {}) => ({
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  hasModeVent: true,
  hasModeDry: true,
  usesSetPointInDryMode: true,
  ...over,
});

// ---- Write path ----------------------------------------------------------

test('setting a target temperature in DRY sends spCool, not spHeat', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone()); // dry, no profile yet

  await handler.setTargetTemperature(24);

  assert.strictEqual(sendCommandCalls.length, 1, 'a command is sent in dry mode');
  // Before the fix this was { spHeat: 24 }, which the unit ignored / 400'd.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 24 },
    'dry-mode setpoint is written to spCool (no spHeat, no operationMode)');
});

test('DRY setpoint routes to spCool even before the device profile arrives', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // No applyProfile() call — deviceProfile is null, the common startup window.
  handler.updateFromZone(zone());

  await handler.setTargetTemperature(26);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 26 },
    'defaults to a settable dry setpoint until the profile says otherwise');
});

test('DRY setpoint is suppressed when the profile reports usesSetPointInDryMode=false', async () => {
  const { handler, sendCommandCalls, applyProfile } = makeHarness();
  handler.updateFromZone(zone());
  applyProfile(profile({ usesSetPointInDryMode: false }));

  await handler.setTargetTemperature(24);

  // Such a unit dehumidifies at a fixed setpoint and ignores writes; we fall to
  // the catch-all (heat) branch rather than writing a spCool it won't honor.
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 24 },
    'fixed-setpoint dry units do not get a spCool write');
});

test('COOL mode still sends spCool (control — dry branch did not break it)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));

  await handler.setTargetTemperature(24);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 24 });
});

test('HEAT mode still sends spHeat (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));

  await handler.setTargetTemperature(22);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 22 });
});

// ---- Read path -----------------------------------------------------------

test('reading the target temperature in DRY surfaces spCool, not spHeat', async () => {
  const { handler } = makeHarness();
  // Live capture: Kitchen in dry reported spCool=25, spHeat=23 (stale).
  handler.updateFromZone(zone({ spCool: 25, spHeat: 23 }));

  const target = await handler.getTargetTemperature();

  // Before the fix this fell through to the spHeat fallback and returned 23.
  assert.strictEqual(target, 25, 'dry surfaces the spCool setpoint');
});

test('DRY read falls back to spHeat when the profile says no dry setpoint', async () => {
  const { handler, applyProfile } = makeHarness();
  handler.updateFromZone(zone({ spCool: 25, spHeat: 23 }));
  applyProfile(profile({ usesSetPointInDryMode: false }));

  const target = await handler.getTargetTemperature();

  assert.strictEqual(target, 23,
    'a fixed-setpoint dry unit surfaces the existing fallback, not an unrelated spCool');
});
