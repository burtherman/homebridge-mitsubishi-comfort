'use strict';

// Dry mode's setpoint lives in spCool.
//
// On the Kumo v3 cloud, dry holds its temperature setpoint in `spCool` (there is no
// spDry). 1.5.3 fixed a bug where dry routed through a catch-all that wrote spHeat,
// which the unit ignored. Live-confirmed: a unit in dry reported spCool=25, spHeat=23,
// and writing spCool while in dry is adopted with the unit staying in dry.
//
// On the HeaterCooler (2.0) that routing is structural: dry reports target COOL, so
// the Home app shows the cooling threshold, which reads and writes spCool. The
// profile's `usesSetPointInDryMode` still gates the one place the plugin adds a dry
// setpoint on its own: a power-on that restores dry.
//
// Values are on the whole-°F grid: 23.9 = 75°F, 26.7 = 80°F.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeLog, makeAccessory } = require('./helpers');

const SERIAL = 'TESTSERIAL001';

function makeHarness() {
  const sent = [];
  let profileCb = null;
  const platform = { Service, Characteristic, log: makeLog(), api: { updatePlatformAccessories() {} } };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand(serial, commands) {
      sent.push(commands);
      return Promise.resolve(true);
    },
  };
  const accessory = makeAccessory('Kitchen', SERIAL);
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, sent, applyProfile: (p) => profileCb(SERIAL, p) };
}

const profile = (over = {}) => ({
  numberOfFanSpeeds: 3, hasFanSpeedAuto: true, hasVaneDir: false, hasVaneSwing: false,
  hasModeDry: true, hasModeHeat: true, hasModeVent: true, hasDefrost: true, hasStandby: true,
  usesSetPointInDryMode: true,
  minimumSetPoints: { heat: 16, cool: 19, auto: 17 },
  maximumSetPoints: { heat: 31, cool: 30, auto: 30 },
  ...over,
});

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'dry',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 25, spHeat: 23, spAuto: null, humidity: null,
    ...over,
  },
});

test('in DRY the tile shows COOL with the cooling threshold at spCool', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spCool: 25, spHeat: 23 }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), Characteristic.TargetHeaterCoolerState.COOL);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 25, 'dry surfaces spCool, not the stale spHeat');
});

test('in DRY the cooling threshold writes spCool, before the profile arrives too', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone()); // no profile yet: the common startup window
  await handler.setCoolingThresholdTemperature(23.9);
  assert.deepStrictEqual(sent, [{ spCool: 23.9 }], 'no spHeat, and no operationMode that would leave dry');
});

test('power-on restoring DRY carries a same-burst spCool when the unit uses a dry setpoint', async () => {
  const { handler, sent, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await Promise.all([
    handler.setCoolingThresholdTemperature(26.7),
    handler.setActive(Characteristic.Active.ACTIVE),
  ]);
  assert.deepStrictEqual(sent, [{ operationMode: 'dry', spCool: 26.7 }]);
});

test('...but not when the profile says dry has a fixed setpoint', async () => {
  const { handler, sent, applyProfile } = makeHarness();
  applyProfile(profile({ usesSetPointInDryMode: false }));
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await Promise.all([
    handler.setCoolingThresholdTemperature(26.7),
    handler.setActive(Characteristic.Active.ACTIVE),
  ]);
  assert.deepStrictEqual(sent, [{ operationMode: 'dry' }], 'a fixed-setpoint dry unit gets no spCool with its power-on');
});
