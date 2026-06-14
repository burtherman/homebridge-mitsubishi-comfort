'use strict';

// Integration tests for local control wiring in the accessory:
//  - updateFromLocal() feeds a locally-read status into the characteristics
//  - local is authoritative: a cloud (polling/streaming) update is dropped while a
//    recent local poll exists (the cloud lags ~7-10s and would clobber it)
//  - sendDeviceCommand() prefers local and falls back to cloud on local failure

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
  const entries = [{ type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) }];
  return {
    displayName: 'Kitchen',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Kitchen' } },
    getService(type) { const e = entries.find((x) => x.type === type && x.subtype === undefined); return e ? e.svc : null; },
    getServiceById(type, subtype) { const e = entries.find((x) => x.type === type && x.subtype === subtype); return e ? e.svc : null; },
    addService(type, name, subtype) { const svc = makeService(type, name, subtype); entries.push({ type, subtype, svc }); return svc; },
    removeService(svc) { const i = entries.findIndex((x) => x.svc === svc); if (i >= 0) entries.splice(i, 1); },
  };
}

function makeLocalClient(over = {}) {
  const calls = [];
  return {
    calls,
    hasLocalResult: true,
    sendCommandResult: true,
    hasLocal() { return this.hasLocalResult; },
    sendCommand(serial, commands) { calls.push({ serial, commands }); return Promise.resolve(this.sendCommandResult); },
    getStatus() { return Promise.resolve(null); },
    ...over,
  };
}

function makeHarness({ localClient = null } = {}) {
  const sendCommandCalls = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    localClient,
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(serial, commands) { sendCommandCalls.push({ serial, commands }); return Promise.resolve(true); },
  };
  const handler = new KumoThermostatAccessory(platform, makeAccessory(), kumoAPI, 30);
  return { handler, sendCommandCalls, platform };
}

const localStatus = (over = {}) => ({
  roomTemp: 24, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20,
  spAuto: null, fanSpeed: 'auto', airDirection: 'auto', filterDirty: false,
  defrost: false, standby: false, ...over,
});

const cloudZone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 30, spCool: 28, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
});

// ---- updateFromLocal ------------------------------------------------------

test('updateFromLocal feeds a locally-read status into the characteristics', async () => {
  const { handler } = makeHarness();
  handler.updateFromLocal(localStatus({ roomTemp: 24, operationMode: 'cool', spCool: 23 }));

  assert.strictEqual(await handler.getCurrentTemperature(), 24);
  assert.strictEqual(await handler.getTargetTemperature(), 23, 'cool mode surfaces spCool');
});

// ---- local authoritative --------------------------------------------------

test('a cloud update is dropped while a recent local poll exists', async () => {
  const { handler } = makeHarness();
  handler.updateFromLocal(localStatus({ roomTemp: 24 }));
  // Cloud streaming/polling lags and reports a stale 30°C — must NOT clobber local.
  handler.updateFromZone(cloudZone({ roomTemp: 30 }));

  assert.strictEqual(await handler.getCurrentTemperature(), 24, 'local stays authoritative');
});

test('cloud updates still apply when no local data exists', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(cloudZone({ roomTemp: 30 }));
  assert.strictEqual(await handler.getCurrentTemperature(), 30, 'pure-cloud path unaffected');
});

// ---- sendDeviceCommand routing --------------------------------------------

test('commands prefer the local path when a unit is locally reachable', async () => {
  const local = makeLocalClient();
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setTargetTemperature(22);

  assert.deepStrictEqual(local.calls.map((c) => c.commands), [{ spHeat: 22 }], 'sent locally');
  assert.strictEqual(sendCommandCalls.length, 0, 'cloud not used');
});

test('a failed local command falls back to the cloud', async () => {
  const local = makeLocalClient({ sendCommandResult: false });
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setTargetTemperature(22);

  assert.strictEqual(local.calls.length, 1, 'local attempted first');
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: 22 }], 'then cloud');
});

test('commands skip local when the unit is not locally reachable', async () => {
  const local = makeLocalClient({ hasLocalResult: false });
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setTargetTemperature(22);

  assert.strictEqual(local.calls.length, 0, 'local not attempted');
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: 22 }], 'cloud used');
});
