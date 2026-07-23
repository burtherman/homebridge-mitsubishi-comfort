'use strict';

// applyMirror (target side): reconstructs one atomic command from a source's
// desired state, normalized, clamped to this unit's range, and capability-guarded.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTTARGET01';

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
  const ch = { value: undefined, onGet() { return ch; }, onSet() { return ch; }, setProps() { return ch; } };
  return ch;
}

function makeService(type, name, subtype) {
  const chars = new Map();
  const svc = {
    type, name, subtype,
    getCharacteristic(id) { if (!chars.has(id)) chars.set(id, makeCharacteristic()); return chars.get(id); },
    setCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    updateCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
  };
  return svc;
}

function makeAccessory() {
  const entries = [{ type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) }];
  return {
    displayName: 'Target',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Target' } },
    getService(type) { const e = entries.find((x) => x.type === type && x.subtype === undefined); return e ? e.svc : null; },
    getServiceById(type, subtype) { const e = entries.find((x) => x.type === type && x.subtype === subtype); return e ? e.svc : null; },
    addService(type, name, subtype) { const svc = makeService(type, name, subtype); entries.push({ type, subtype, svc }); return svc; },
    removeService(svc) { const i = entries.findIndex((x) => x.svc === svc); if (i >= 0) entries.splice(i, 1); },
  };
}

const profile = (over = {}) => ({
  numberOfFanSpeeds: 5, hasFanSpeedAuto: true,
  hasModeDry: true, usesSetPointInDryMode: true,
  hasModeHeat: true, hasModeVent: true, hasVaneDir: true, hasVaneSwing: true,
  hasDefrost: true, hasStandby: true,
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  ...over,
});

function makeHarness() {
  const sendCommandCalls = [];
  let profileCb = null;
  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {} },
    localClient: null,
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand(serial, commands) { sendCommandCalls.push({ serial, commands }); return Promise.resolve(true); },
  };
  const handler = new KumoThermostatAccessory(platform, makeAccessory(), kumoAPI, 30);
  const setProfile = (p) => profileCb(SERIAL, p);
  return { handler, sendCommandCalls, setProfile };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
});

test('heat mirror sends one combined operationMode + spHeat + raw fan', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'heat', power: 1, spHeat: 21.5, spCool: 24, fanSpeed: 'powerful' });
  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'heat', spHeat: 21.5, fanSpeedRaw: 'powerful' });
});

test('off mirror sends operationMode:off only (no setpoint, no fan)', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.applyMirror({ operationMode: 'off', power: 0, spHeat: 21, spCool: 24, fanSpeed: 'auto' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'off' });
});

test('autoHeat normalizes to auto with both setpoints', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'autoHeat', power: 1, spHeat: 20, spCool: 25, fanSpeed: 'auto' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'auto', spHeat: 20, spCool: 25, fanSpeedRaw: 'auto' });
});

test('a setpoint above the target range is clamped to the target limit', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile({ maximumSetPoints: { cool: 30, heat: 28, auto: 30 } }));
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.applyMirror({ operationMode: 'heat', power: 1, spHeat: 35, spCool: 24, fanSpeed: 'auto' });
  assert.strictEqual(sendCommandCalls[0].commands.spHeat, 28);
});

test('dry mirror sends spCool + power when the target uses a dry setpoint', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile({ usesSetPointInDryMode: true }));
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'dry', power: 1, spHeat: 20, spCool: 23, fanSpeed: 'quiet' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'dry', power: 1, spCool: 23, fanSpeedRaw: 'quiet' });
});

test('a target without dry capability skips a dry mirror', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile({ hasModeDry: false }));
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'dry', power: 1, spHeat: 20, spCool: 23, fanSpeed: 'auto' });
  assert.strictEqual(sendCommandCalls.length, 0);
});

test('vent mirror sends operationMode:vent + power + fan, no setpoint', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile({ hasModeVent: true }));
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.applyMirror({ operationMode: 'vent', power: 1, spHeat: 20, spCool: 23, fanSpeed: 'low' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'vent', power: 1, fanSpeedRaw: 'low' });
});

test('cool mirror sends operationMode:cool + spCool + fan', async () => {
  const { handler, sendCommandCalls, setProfile } = makeHarness();
  setProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.applyMirror({ operationMode: 'cool', power: 1, spHeat: 20, spCool: 22.2, fanSpeed: 'auto' });
  assert.deepStrictEqual(sendCommandCalls[0].commands, { operationMode: 'cool', spCool: 22.2, fanSpeedRaw: 'auto' });
});
