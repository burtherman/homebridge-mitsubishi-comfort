'use strict';

// Regression test: a scene/automation "turn off" must actually turn off a unit
// that is running in DRY (or fan-only VENT).
//
// Bug: dry and fan-only have no HomeKit Thermostat state, so the plugin reported
// the Thermostat as OFF while the unit was running (dry/vent were surfaced only
// through their separate Dry/Fan switches). A HomeKit off-automation writes the
// Thermostat's TargetHeatingCoolingState = OFF. When the unit was in dry, the
// Thermostat already read OFF, so iOS suppressed the redundant write — the setter
// never fired, no `operationMode:'off'` reached the unit, and the still-ON Dry
// switch kept it dehumidifying. Live-confirmed the trigger is a scene/automation.
//
// Fix (B): report a running (non-OFF) Thermostat state — COOL — while in dry/vent,
// so an off-automation registers a real COOL→OFF transition, fires the setter, and
// turns the unit off. CurrentHeatingCoolingState stays OFF (the unit isn't actively
// heating/cooling), and the Dry/Fan switches still own dry/vent control.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';
const OFF = 0, HEAT = 1, COOL = 2, AUTO = 3;

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) {
      charCache[prop] = { _name: String(prop), OFF, HEAT, COOL, AUTO };
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
  const thermostat = accessory.getService(Service.Thermostat);
  return { handler, accessory, thermostat, sendCommandCalls };
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

// ---- Target state: dry/vent must NOT read OFF while running ----------------

test('a unit running in DRY reports a non-OFF thermostat target', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  const target = await handler.getTargetHeatingCoolingState();

  // Before the fix this was OFF, so a scene "set Off" was a suppressed no-op.
  assert.notStrictEqual(target, OFF, 'dry must not read OFF (would make off a no-op)');
  assert.strictEqual(target, COOL, 'dry maps to COOL (its setpoint lives in spCool)');
});

test('a unit running in fan-only VENT reports a non-OFF thermostat target', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));

  const target = await handler.getTargetHeatingCoolingState();

  assert.notStrictEqual(target, OFF, 'vent must not read OFF (would make off a no-op)');
  assert.strictEqual(target, COOL);
});

test('a genuinely OFF unit still reports thermostat OFF (control)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  assert.strictEqual(await handler.getTargetHeatingCoolingState(), OFF);
});

test('HEAT and COOL still map correctly (control — no regression)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat', power: 1 }));
  assert.strictEqual(await handler.getTargetHeatingCoolingState(), HEAT);
  handler.updateFromZone(zone({ operationMode: 'cool', power: 1 }));
  assert.strictEqual(await handler.getTargetHeatingCoolingState(), COOL);
});

// ---- Current state reads COOL so a running dry/vent unit is visibly on ------

test('DRY reports CurrentHeatingCoolingState COOL (visibly running, not "Off")', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  // The tile's status label follows Current; COOL makes a running dry unit show
  // "Cooling" instead of a misleading "Off" (the Dry switch may be invisible).
  assert.strictEqual(await handler.getCurrentHeatingCoolingState(), COOL);
});

test('VENT reports CurrentHeatingCoolingState COOL (visibly running)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));

  assert.strictEqual(await handler.getCurrentHeatingCoolingState(), COOL);
});

test('a powered-off unit still reports CurrentHeatingCoolingState OFF (control)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  assert.strictEqual(await handler.getCurrentHeatingCoolingState(), OFF);
});

// ---- The off write still routes to operationMode:'off' ----------------------

test('setting the thermostat OFF on a dry unit sends operationMode off', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));

  await handler.setTargetHeatingCoolingState(OFF);

  assert.deepStrictEqual(sendCommandCalls.at(-1).commands, { operationMode: 'off' },
    'off from a dry unit turns it off');
});

// ---- Optimistic window: turning Dry ON must not leave target at OFF ---------

test('turning the Dry switch ON leaves the thermostat target non-OFF immediately', async () => {
  const { handler, thermostat } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));

  await handler.setDryOn(true);

  // If the optimistic update left target at OFF, an off-automation firing before
  // the next poll would be suppressed again — reintroducing the bug in that window.
  const target = thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState).value;
  assert.strictEqual(target, COOL, 'optimistic target reflects the running (COOL) state');
});
