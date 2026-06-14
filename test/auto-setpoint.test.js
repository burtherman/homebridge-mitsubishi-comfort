'use strict';

// Regression test for AUTO-mode dual setpoints.
//
// HomeKit's Thermostat shows a temperature *range* (two handles) in AUTO when
// the optional HeatingThresholdTemperature / CoolingThresholdTemperature
// characteristics are present. These units report spAuto: null and keep the auto
// band in spHeat (low/heat bound) and spCool (high/cool bound) — verified against
// live device data (every poll showed `Auto: null` with independent spHeat/spCool).
//
// Before this change AUTO collapsed to the single TargetTemperature (which, with
// spAuto null, fell back to spHeat), so the cooling side of the band was invisible
// and unsettable. Now:
//   - getHeatingThresholdTemperature -> spHeat,  getCoolingThresholdTemperature -> spCool
//   - setHeatingThresholdTemperature -> { spHeat }, setCoolingThresholdTemperature -> { spCool }
//   - zone updates sync both threshold characteristics
//   - the 1.5.2 powered-off guard applies (no bare setpoint to an off unit)

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

// Read a characteristic value off the Thermostat service.
function thermostatChar(accessory, charKey) {
  return accessory.getService(Service.Thermostat).getCharacteristic(Characteristic[charKey]).value;
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'autoCool',
    fanSpeed: null, airDirection: null,
    roomTemp: 23, spCool: 26, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

// ---- Read path -----------------------------------------------------------

test('heating threshold reads spHeat, cooling threshold reads spCool', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 26);
});

test('zone updates sync both AUTO threshold characteristics', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 19, spCool: 27 }));

  assert.strictEqual(thermostatChar(accessory, 'HeatingThresholdTemperature'), 19,
    'spHeat is pushed to the heating handle');
  assert.strictEqual(thermostatChar(accessory, 'CoolingThresholdTemperature'), 27,
    'spCool is pushed to the cooling handle');
});

// ---- Write path ----------------------------------------------------------

test('setting the heating threshold in AUTO sends spHeat only', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setHeatingThresholdTemperature(21);

  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 21 },
    'heating handle writes spHeat (no spCool, no operationMode)');
});

test('setting the cooling threshold in AUTO sends spCool only', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());

  await handler.setCoolingThresholdTemperature(25);

  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 25 },
    'cooling handle writes spCool (no spHeat, no operationMode)');
});

test('dragging the band sends two independent commands, not a collapsed pair', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  await handler.setHeatingThresholdTemperature(21);
  await handler.setCoolingThresholdTemperature(25);

  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands),
    [{ spHeat: 21 }, { spCool: 25 }],
    'the band stays two-sided; neither write clobbers the other edge');
});

test('an accepted threshold write optimistically updates cached state', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));

  await handler.setCoolingThresholdTemperature(24);

  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 24,
    'the new spCool is reflected immediately, before the next poll');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20,
    'the heating edge is untouched');
});

// ---- Powered-off guard (inherits the 1.5.2 behavior) ---------------------

test('threshold writes to a powered-off unit are cached, not sent', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));

  await handler.setHeatingThresholdTemperature(22);

  assert.strictEqual(sendCommandCalls.length, 0,
    'no bare setpoint is sent to an off unit (would 400 modeRequiredWhenDeviceOff)');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 22,
    'the value is cached + echoed so the handle holds');
});

// ---- Controls: single-setpoint modes are unaffected ----------------------

test('HEAT-mode TargetTemperature still sends spHeat (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));

  await handler.setTargetTemperature(22);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 22 },
    'the new threshold characteristics did not disturb the heat path');
});

test('COOL-mode TargetTemperature still sends spCool (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));

  await handler.setTargetTemperature(23);

  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 23 });
});
