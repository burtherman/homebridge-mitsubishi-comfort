'use strict';

// The source-side status hook: onStatusUpdate must fire both when an update is
// observed (streaming/poll/local, via processZoneUpdate) AND when a HomeKit
// setter changes this unit — so a HomeKit change to the source mirrors without
// waiting for the echo. It must NOT fire on a dropped/no-op path.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSOURCE01';

function makeLog() { const noop = () => {}; return { info: noop, warn: noop, error: noop, debug: noop }; }

const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) { charCache[prop] = { _name: String(prop), OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 }; }
    return charCache[prop];
  },
});
const Service = { AccessoryInformation: 'AccessoryInformation', Thermostat: 'Thermostat', Switch: 'Switch', FilterMaintenance: 'FilterMaintenance' };

function makeCharacteristic() { const ch = { value: undefined, onGet() { return ch; }, onSet() { return ch; }, setProps() { return ch; } }; return ch; }
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
    displayName: 'Source',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Source' } },
    getService(type) { const e = entries.find((x) => x.type === type && x.subtype === undefined); return e ? e.svc : null; },
    getServiceById(type, subtype) { const e = entries.find((x) => x.type === type && x.subtype === subtype); return e ? e.svc : null; },
    addService(type, name, subtype) { const svc = makeService(type, name, subtype); entries.push({ type, subtype, svc }); return svc; },
    removeService(svc) { const i = entries.findIndex((x) => x.svc === svc); if (i >= 0) entries.splice(i, 1); },
  };
}
function makeHarness() {
  const platform = { Service, Characteristic, log: makeLog(), api: { updatePlatformAccessories() {} }, localClient: null };
  const kumoAPI = {
    subscribeToDevice() {}, onDeviceProfileUpdate() {},
    sendCommand() { return Promise.resolve(true); },
  };
  const handler = new KumoThermostatAccessory(platform, makeAccessory(), kumoAPI, 30);
  return { handler };
}
const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'heat',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 21, spCool: 24, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
});

test('onStatusUpdate fires on an observed (polled) update with the new state', () => {
  const { handler } = makeHarness();
  const seen = [];
  handler.onStatusUpdate((s) => seen.push({ mode: s.operationMode, spHeat: s.spHeat }));
  handler.updateFromZone(zone({ operationMode: 'heat', spHeat: 22 }));
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0], { mode: 'heat', spHeat: 22 });
});

test('onStatusUpdate fires after a HomeKit setpoint change (setter hook)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat', spHeat: 20 })); // seed status
  const seen = [];
  handler.onStatusUpdate((s) => seen.push(s.spHeat));
  await handler.setTargetTemperature(23);
  assert.ok(seen.includes(23), `expected a listener fire with spHeat 23, got ${JSON.stringify(seen)}`);
});

test('onStatusUpdate fires after a HomeKit mode change (setter hook)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' })); // seed status
  const seen = [];
  handler.onStatusUpdate((s) => seen.push(s.operationMode));
  await handler.setTargetHeatingCoolingState(Characteristic.TargetHeatingCoolingState.COOL);
  assert.ok(seen.includes('cool'), `expected a listener fire with mode cool, got ${JSON.stringify(seen)}`);
});

test('multiple listeners are all invoked', () => {
  const { handler } = makeHarness();
  let a = 0; let b = 0;
  handler.onStatusUpdate(() => { a++; });
  handler.onStatusUpdate(() => { b++; });
  handler.updateFromZone(zone());
  assert.strictEqual(a, 1);
  assert.strictEqual(b, 1);
});
