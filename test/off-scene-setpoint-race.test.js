'use strict';

// Regression test: an "AC off" scene must not leave a unit running.
//
// A HomeKit "turn off AC" scene captures each unit's full state and, when it
// fires, re-pushes the off *and* the captured mode and setpoints. On the 1.x
// Thermostat that was TargetHeatingCoolingState=OFF plus TargetTemperature and the
// two threshold handles; on the 2.0 HeaterCooler it's Active=0 plus
// TargetHeaterCoolerState and the two thresholds. HomeKit dispatches these
// concurrently in an arbitrary order. A setpoint dispatched
// after the off reaches the LAN adapter as a bare, mode-less write (local
// setpoint commands carry no mode/power — see local-api.ts) and powers the unit
// back on. Observed live 2026-07-11: the Living room (an AUTO unit) "restarted"
// in dry after the off automation, because its two AUTO threshold writes were
// dispatched after the off — the mutex sent {mode:off} then two bare setpoints.
//
// Fix: a HomeKit off request opens a short suppression window; setpoint writes
// during it are cached/echoed but not sent, so the off is the last thing the
// adapter sees. The setpoints dispatched *before* the off are harmless — the off
// follows and wins.

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

const isOff = (c) => c.commands.operationMode === 'off';
const isSetpoint = (c) =>
  c.commands.spHeat !== undefined || c.commands.spCool !== undefined;

test('AC-off scene: no setpoint reaches the device after the off (unit stays off)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  // Living room was running in dry. Seed that on state the way a poll would.
  handler.updateFromZone(zone({ power: 1, operationMode: 'dry', spCool: 24, spHeat: 20 }));

  // The HeaterCooler form of the dispatch order captured in the 06:49:01 log
  // (then: TargetTemperature(21) → OFF → CoolingThreshold(25) → HeatingThreshold(21)):
  // a setpoint, the off, the captured mode, another setpoint. Fired concurrently
  // (not awaited between) to mirror HomeKit's concurrent dispatch — this is what
  // lets a setpoint's guard check run before the off's optimistic update lands.
  const p1 = handler.setCoolingThresholdTemperature(25);
  const p2 = handler.setActive(Characteristic.Active.INACTIVE);
  const p3 = handler.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.COOL);
  const p4 = handler.setHeatingThresholdTemperature(21.2);
  await Promise.all([p1, p2, p3, p4]);

  const offIdx = sendCommandCalls.findIndex(isOff);
  assert.ok(offIdx >= 0, 'the off command is still sent (1.7.1 off-fix preserved)');

  const setpointAfterOff = sendCommandCalls.slice(offIdx + 1).some(isSetpoint);
  assert.ok(
    !setpointAfterOff,
    'no setpoint command may follow the off — a trailing bare setpoint revives the unit. ' +
      'Got: ' + JSON.stringify(sendCommandCalls.map((c) => c.commands)),
  );
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ operationMode: 'off' }],
    'the captured mode rides along with the off instead of reviving the unit');
});

test('a threshold write dispatched right after an off is suppressed', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'cool' }));

  const pOff = handler.setActive(Characteristic.Active.INACTIVE);
  const pSp = handler.setCoolingThresholdTemperature(25);
  await Promise.all([pOff, pSp]);

  const setpoints = sendCommandCalls.filter(isSetpoint);
  assert.strictEqual(
    setpoints.length, 0,
    'a setpoint issued in the same burst as an off must not be sent to the device',
  );
});

test('a threshold write with no recent off still sends (control — AUTO handle drag)', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 1, operationMode: 'auto', spAuto: null }));

  await handler.setCoolingThresholdTemperature(25);

  assert.strictEqual(sendCommandCalls.length, 1, 'the AUTO cooling handle write is sent');
  assert.deepStrictEqual(sendCommandCalls[0].commands, { spCool: 25 });
});
