'use strict';

// Regression test: a scene setpoint dispatched *before* the off must not stick.
//
// The 1.7.2 fix (off-scene-setpoint-race.test.js) stops a setpoint that lands
// AFTER an off from reviving the unit. But HomeKit dispatches a scene's captured
// setpoints and its off concurrently in arbitrary order, and a setpoint that
// lands just BEFORE the off arrives while the unit is still on — so it passes
// the guard and sends, permanently rewriting the device's stored setpoint.
//
// Observed live 2026-07-26 (19:26:56 log burst): the "AC off" scene wrote the
// Living room's stale captured spCool of 25°C, then turned it off. The Living
// room is a mirror target of the Kitchen (22.5°C), and mirroring is
// edge-triggered — nothing re-synced the two until the Kitchen next changed, so
// the two tiles showed setpoints 2.5°C apart for 36 minutes.
//
// Fix: hold each setpoint write briefly before sending it, so an off arriving
// in the same burst cancels it whichever order the two were dispatched in.

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
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName: 'Living room',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Living room' } },
    getService(type) { const e = entries.find((x) => x.type === type && x.subtype === undefined); return e ? e.svc : null; },
    getServiceById(type, subtype) { const e = entries.find((x) => x.type === type && x.subtype === subtype); return e ? e.svc : null; },
    addService(type, name, subtype) { const svc = makeService(type, name, subtype); entries.push({ type, subtype, svc }); return svc; },
    removeService(svc) { const i = entries.findIndex((x) => x.svc === svc); if (i >= 0) entries.splice(i, 1); },
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
    roomTemp: 22, spCool: 22.5, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

const isSetpoint = (c) =>
  c.commands.spHeat !== undefined || c.commands.spCool !== undefined;

test('a scene setpoint dispatched just BEFORE the off never reaches the device', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // Living room running in cool at the mirrored 22.5, the way a poll would seed it.
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool', spCool: 22.5 }));

  // The 19:26:56 dispatch order: the scene's stale captured setpoint first,
  // then the off. Fired concurrently, as HomeKit does.
  const pSp = handler.setCoolingThresholdTemperature(25);
  const pOff = handler.setTargetHeatingCoolingState(Characteristic.TargetHeatingCoolingState.OFF);
  await Promise.all([pSp, pOff]);

  const setpoints = sendCommandCalls.filter(isSetpoint);
  assert.strictEqual(
    setpoints.length, 0,
    'a setpoint dispatched before the off must not rewrite the stored setpoint. ' +
      'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
  assert.ok(
    sendCommandCalls.some((c) => c.commands.operationMode === 'off'),
    'the off itself is still sent',
  );
});

test('the same holds for the plain TargetTemperature setpoint', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool', spCool: 22.5 }));

  const pSp = handler.setTargetTemperature(25);
  const pOff = handler.setTargetHeatingCoolingState(Characteristic.TargetHeatingCoolingState.OFF);
  await Promise.all([pSp, pOff]);

  assert.strictEqual(sendCommandCalls.filter(isSetpoint).length, 0);
});

test('control: a setpoint with no off in the burst still sends', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool', spCool: 22.5 }));

  await handler.setTargetTemperature(23.5);

  assert.strictEqual(sendCommandCalls.length, 1);
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 23.5 });
});

test('a drag sends only its final value', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool', spCool: 22.5 }));

  await Promise.all([
    handler.setTargetTemperature(23),
    handler.setTargetTemperature(23.5),
    handler.setTargetTemperature(24),
  ]);

  assert.strictEqual(sendCommandCalls.length, 1, 'intermediate drag values are superseded');
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 24 });
});

test('the two AUTO handles do not supersede each other', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'auto', spAuto: null }));

  await Promise.all([
    handler.setHeatingThresholdTemperature(20),
    handler.setCoolingThresholdTemperature(25),
  ]);

  assert.strictEqual(sendCommandCalls.length, 2, 'both AUTO handles are independent writes');
  assert.ok(sendCommandCalls.some((c) => c.commands.spHeat === 20));
  assert.ok(sendCommandCalls.some((c) => c.commands.spCool === 25));
});
