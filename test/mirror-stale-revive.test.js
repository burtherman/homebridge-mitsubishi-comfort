'use strict';

// Regression: a stale cloud/streaming reading must not revive a mirror target
// after the source was turned off locally.
//
// Real-world failure (skylight "AC off" scene, 2026-07-23 06:40): the kitchen
// (mirror source) was turned OFF over the LAN, but the Kumo cloud lags ~7-10s and
// a stale `device_update` still reporting the kitchen as `cool` arrived a few
// seconds later. A local command does not refresh the "local authoritative"
// window (only a local poll did), so when the kitchen's local poll was starved
// during the all-units command burst that stale `cool` got APPLIED — briefly
// flipping the kitchen's cached state back to `cool`. That fired the source hook,
// and the mirror sent a REAL `cool` command to the living room, reviving it while
// the kitchen itself was (and stayed) off.
//
// Fix: a successful LOCAL command marks the unit locally-authoritative, so stale
// cloud/streaming updates are dropped for the authoritative window and never reach
// the mirror.

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
  const platform = { Service, Characteristic, log: makeLog(), api: { updatePlatformAccessories() {} }, localClient };
  const kumoAPI = { subscribeToDevice() {}, onDeviceProfileUpdate() {}, sendCommand() { return Promise.resolve(true); } };
  const handler = new KumoThermostatAccessory(platform, makeAccessory(), kumoAPI, 30);
  return { handler };
}

// A cloud (streaming/polling) zone reading for the source.
const cloudZone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 24, spCool: 24, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
});
const localStatus = (over = {}) => ({
  roomTemp: 24, operationMode: 'cool', power: 1, spCool: 24, spHeat: 20,
  spAuto: null, fanSpeed: 'auto', airDirection: 'auto', filterDirty: false,
  defrost: false, standby: false, ...over,
});

test('a stale cloud "cool" after a local OFF does not re-fire the mirror hook', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });

  // Source is cooling; the local-authoritative window is not currently active
  // (the local poll was starved during the command burst — modeled by priming
  // via a cloud reading, leaving lastLocalUpdateTs unset).
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1, spCool: 24 }));

  const seen = [];
  handler.onStatusUpdate((s) => seen.push({ operationMode: s.operationMode, power: s.power }));

  // Skylight scene turns the source OFF over the LAN.
  await handler.setTargetHeatingCoolingState(Characteristic.TargetHeatingCoolingState.OFF);

  // The Kumo cloud lags and replays the pre-off "cool" state.
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1, spCool: 24 }));

  // The mirror must never observe an on-state after the off — otherwise it would
  // send a real "cool" command to the target and revive it.
  assert.ok(
    seen.length > 0 && seen.every((s) => s.operationMode === 'off' && s.power === 0),
    `mirror hook saw a phantom revive after off: ${JSON.stringify(seen)}`,
  );
});

test('a REAL local change after an OFF still fires the mirror hook (following preserved)', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });

  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1, spCool: 24 }));
  const seen = [];
  handler.onStatusUpdate((s) => seen.push({ operationMode: s.operationMode, power: s.power }));

  await handler.setTargetHeatingCoolingState(Characteristic.TargetHeatingCoolingState.OFF);

  // A genuine local poll (e.g. someone used the wall thermostat) reads cool — the
  // mirror MUST still follow this (the fix only blocks stale *cloud* data, never
  // authoritative local reads).
  handler.updateFromLocal(localStatus({ operationMode: 'cool', power: 1, spCool: 23 }));

  assert.ok(
    seen.some((s) => s.operationMode === 'cool' && s.power === 1),
    `mirror hook should follow a real local change: ${JSON.stringify(seen)}`,
  );
});
