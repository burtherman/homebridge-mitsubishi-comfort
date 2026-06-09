'use strict';

// Regression test for the off-unit setpoint bug.
//
// HomeKit's Thermostat service sends TargetTemperature independently of
// TargetHeatingCoolingState. When an automation (e.g. "turn off the AC when the
// skylight opens") captures a thermostat's full state, opening the skylight
// re-pushes each unit's last setpoint alongside `off`. The old code's off branch
// sent a bare `{ spHeat: temp }` with no operationMode, which the Kumo v3 API
// rejects with `modeRequiredWhenDeviceOff` (HTTP 400) — producing a cluster of
// red errors on every skylight-open event even though the unit shut off fine.
//
// The unit is off, so there is nothing to set: no command should be sent. The
// requested value is cached + echoed to HomeKit so the slider doesn't snap back.

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

function makeHarness() {
  const sendCommandCalls = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(serial, commands) {
      sendCommandCalls.push({ serial, commands });
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, sendCommandCalls };
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

test('setting a target temperature while the unit is OFF sends no command', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // Seed an OFF status the way a streaming/poll update would.
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spHeat: 20 }));

  await handler.setTargetTemperature(21);

  // Before the fix this was 1: a bare { spHeat: 21 } that the API rejected with
  // modeRequiredWhenDeviceOff. The unit is off, so nothing should be sent.
  assert.strictEqual(sendCommandCalls.length, 0,
    'no API command should be sent when the unit is off');
});

test('setting a target temperature while OFF still echoes the value to HomeKit', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off', spHeat: 20 }));

  await handler.setTargetTemperature(21);

  const target = accessory.getService(Service.Thermostat)
    .getCharacteristic(Characteristic.TargetTemperature);
  assert.strictEqual(target.value, 21,
    'HomeKit target temperature still reflects the requested value (slider holds)');
});

test('setting a target temperature while HEATING still sends the setpoint (control)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'heat', spHeat: 20 }));

  await handler.setTargetTemperature(22);

  assert.strictEqual(sendCommandCalls.length, 1, 'heat-mode setpoint is sent to the API');
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spHeat: 22 },
    'sends the heat setpoint with no spurious fields');
});
