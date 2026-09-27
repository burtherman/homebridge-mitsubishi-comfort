'use strict';

// Regression tests for adapter-reachability -> HomeKit "No Response".
//
// 2026-09-10: the rear bedroom's Wi-Fi adapter dropped off the network for ~22h.
// The Kumo cloud kept serving its last known state (`cool, power=1`) from a frozen
// shadow record, so HomeKit showed a confident, wrong tile and every `off` an
// automation sent returned HTTP 200 while reaching nothing. The cloud had been
// telling us the truth the whole time via `device_status_v2` ("reported offline
// (reason: IoT Disconnected)") — the callback simply had no subscriber.
//
// These tests drive the compiled accessory with a minimal HAP mock and assert the
// accessory refuses to serve stale state as live once the adapter is known offline.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// Real hap-nodejs enum values (see test/helpers.js). The old per-file fake gave
// every characteristic AUTO=3, which is only true of TargetHeatingCoolingState.
const { Characteristic } = require('./helpers');

const { Service } = require('./helpers');

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
    displayName: 'Rear bedroom',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Rear bedroom' } },
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

// Mirrors homebridge's hap namespace closely enough to exercise the real path.
class HapStatusError extends Error {
  constructor(status) {
    super(`HAP status ${status}`);
    this.hapStatus = status;
  }
}
const hap = { HapStatusError, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } };

function makeHarness({ log = makeLog(), localSerials = [], withHap = true } = {}) {
  const platform = {
    Service,
    Characteristic,
    log,
    api: withHap ? { updatePlatformAccessories() {}, hap } : { updatePlatformAccessories() {} },
    localClient: {
      hasLocal: (serial) => localSerials.includes(serial),
      sendCommand: async () => true,
    },
  };
  const sent = [];
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand: async (serial, commands) => { sent.push(commands); return true; },
    getDeviceStatus: async () => null,
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  const tile = accessory.getService(Service.HeaterCooler);
  return { handler, accessory, platform, tile, sent };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 26.5, spCool: 24.5, spHeat: 23.5, spAuto: null, humidity: null,
    ...over,
  },
});

async function assertRejects(fn, message) {
  await assert.rejects(fn, (err) => err instanceof Error, message);
}

test('an adapter the cloud reports offline goes No Response instead of serving stale state', async () => {
  const { handler, tile } = makeHarness();
  handler.updateFromZone(zone());

  // Baseline: reachable, real values published.
  assert.strictEqual(tile.getCharacteristic(Characteristic.CurrentTemperature).value, 26.5);
  assert.strictEqual(await handler.getCurrentTemperature(), 26.5);

  handler.setCloudConnected(false);

  assert.strictEqual(handler.isReachable(), false);
  await assertRejects(() => handler.getCurrentTemperature(), 'getter throws while unreachable');
  await assertRejects(() => handler.getTargetHeaterCoolerState(), 'mode getter throws too');

  // The error is pushed immediately rather than waiting for HomeKit to read.
  const pushed = tile.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value;
  assert.ok(pushed instanceof Error, 'No Response pushed to the characteristic');
  for (const key of ['Active', 'TargetHeaterCoolerState', 'HeatingThresholdTemperature', 'CoolingThresholdTemperature']) {
    assert.ok(tile.getCharacteristic(Characteristic[key]).value instanceof Error, `${key} pushed No Response too`);
  }
  assert.strictEqual(pushed.hapStatus, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
});

test('a stale shadow replay does NOT repaint the tile while the adapter is offline', async () => {
  // This is the exact 2026-09-10 failure: the unit was physically OFF but the cloud
  // kept replaying `cool, power=1`. That must not reach HomeKit as if it were live.
  const { handler, tile } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  handler.setCloudConnected(false);

  handler.updateFromZone(zone({ operationMode: 'cool', power: 1, roomTemp: 26.5 }));

  const current = tile.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value;
  assert.ok(current instanceof Error, 'stale replay left the tile in No Response, not "Cooling"');
});

test('recovery republishes real state and clears No Response', async () => {
  const { handler, tile } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  handler.setCloudConnected(false);
  assert.ok(tile.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value instanceof Error);

  handler.setCloudConnected(true);

  assert.strictEqual(handler.isReachable(), true);
  const current = tile.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value;
  assert.ok(!(current instanceof Error), 'characteristic no longer an error');
  assert.strictEqual(current, Characteristic.CurrentHeaterCoolerState.INACTIVE);
  assert.strictEqual(await handler.getCurrentTemperature(), 26.5, 'getters serve values again');
});

test('local LAN control keeps a unit reachable even when the cloud calls it offline', async () => {
  // Local control bypasses the cloud entirely, so a cloud-side disconnect says
  // nothing about our ability to read or drive the unit.
  const { handler } = makeHarness({ localSerials: [SERIAL] });
  handler.updateFromZone(zone());

  handler.setCloudConnected(false);

  assert.strictEqual(handler.isReachable(), true);
  assert.strictEqual(await handler.getCurrentTemperature(), 26.5);
});

test('writes fail loudly against an offline adapter instead of reporting success', async () => {
  // The original complaint: an "AC off" scene reported success while the command
  // reached nothing. A write that cannot be delivered must surface as an error.
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone());
  handler.setCloudConnected(false);

  await assertRejects(() => handler.setActive(0), 'power write rejected');
  await assertRejects(() => handler.setTargetHeaterCoolerState(2), 'mode write rejected');
  await assertRejects(() => handler.setCoolingThresholdTemperature(22.3), 'setpoint write rejected');
  assert.strictEqual(sent.length, 0, 'nothing was sent to an adapter known to be offline');
});

test('a device that has never reported status is treated as reachable', async () => {
  // null (nothing reported yet) must not flash No Response at startup.
  const { handler } = makeHarness();
  assert.strictEqual(handler.isReachable(), true);
  handler.updateFromZone(zone());
  assert.strictEqual(await handler.getCurrentTemperature(), 26.5);
});

test('reachability still degrades correctly without hap on the platform api', async () => {
  // Defensive: the error builder falls back to a plain Error so a stubbed api
  // (or a homebridge version that moves the namespace) cannot break the guard.
  const { handler } = makeHarness({ withHap: false });
  handler.updateFromZone(zone());
  handler.setCloudConnected(false);
  await assertRejects(() => handler.getCurrentTemperature(), 'still throws without hap');
});
