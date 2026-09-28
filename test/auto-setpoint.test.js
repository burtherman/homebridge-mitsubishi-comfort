'use strict';

// Setpoints on the HeaterCooler (2.0).
//
// The two threshold characteristics are the setpoint controls in EVERY mode: the
// heating threshold is spHeat (shown in HEAT), the cooling threshold is spCool
// (shown in COOL), and both form the band in AUTO. These units report spAuto: null
// and keep the auto band in spHeat/spCool (verified against live device data).
//
// History: on the 1.x Thermostat these were AUTO-only extras next to a single
// TargetTemperature that wrote one field or both depending on mode. That second
// writer is gone, so a scene re-sending a captured target can't collapse the band.
//
// Every write is snapped to the whole-°F grid (src/temperature.ts), so the values
// below are chosen on it: 20 = 68°F, 21.2 = 70°F, 22.3 = 72°F, 25 = 77°F.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeLog, makeAccessory } = require('./helpers');

const SERIAL = 'TESTSERIAL001';

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
  const accessory = makeAccessory('Kitchen', SERIAL);
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, sendCommandCalls, applyProfile: (p) => profileCb(SERIAL, p) };
}

const heaterCooler = (accessory) => accessory.getService(Service.HeaterCooler);
const charValue = (accessory, key) => heaterCooler(accessory).getCharacteristic(Characteristic[key]).value;
const charProps = (accessory, key) => heaterCooler(accessory).getCharacteristic(Characteristic[key]).props;

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'autoCool',
    fanSpeed: null, airDirection: null,
    roomTemp: 23, spCool: 26, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

const profile = (over = {}) => ({
  numberOfFanSpeeds: 3, hasFanSpeedAuto: true, hasVaneDir: false, hasVaneSwing: false,
  hasModeDry: true, hasModeHeat: true, hasModeVent: true, hasDefrost: true, hasStandby: true,
  usesSetPointInDryMode: true,
  minimumSetPoints: { heat: 16, cool: 19, auto: 17 },
  maximumSetPoints: { heat: 31, cool: 30, auto: 30 },
  ...over,
});

// ---- Read path -----------------------------------------------------------

test('heating threshold reads spHeat, cooling threshold reads spCool', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 26);
});

test('zone updates sync both threshold characteristics', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 19, spCool: 27 }));
  assert.strictEqual(charValue(accessory, 'HeatingThresholdTemperature'), 19);
  assert.strictEqual(charValue(accessory, 'CoolingThresholdTemperature'), 27);
});

// ---- Write path ----------------------------------------------------------

test('the heating threshold sends spHeat only', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());
  await handler.setHeatingThresholdTemperature(21.2);
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: 21.2 }]);
});

test('the cooling threshold sends spCool only', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone());
  await handler.setCoolingThresholdTemperature(25);
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spCool: 25 }]);
});

test('dragging the band sends two independent commands, not a collapsed pair', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));
  await handler.setHeatingThresholdTemperature(21.2);
  await handler.setCoolingThresholdTemperature(25);
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: 21.2 }, { spCool: 25 }]);
});

test('HEAT mode: the heating threshold is the setpoint', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.setHeatingThresholdTemperature(22.3);
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: 22.3 }]);
});

test('COOL mode: the cooling threshold is the setpoint', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.setCoolingThresholdTemperature(22.3);
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spCool: 22.3 }]);
});

test('an accepted threshold write optimistically updates cached state', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ spHeat: 20, spCool: 26 }));
  await handler.setCoolingThresholdTemperature(25);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 25);
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 20, 'the heating edge is untouched');
});

// ---- Whole-°F grid -------------------------------------------------------

test('a 72°F write arriving as a raw Celsius float is stored as 22.3', async () => {
  // The Home app converts 72°F to 22.2222…°C. Rounding to 0.1 gives 22.2 = 71.96°F,
  // which the Comfort app (it truncates) shows as 71. 22.3 shows 72 in both.
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.setCoolingThresholdTemperature((72 - 32) * 5 / 9);
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spCool: 22.3 }]);
});

test('a write outside the unit\'s range lands on the nearest whole °F inside it', async () => {
  const { handler, sendCommandCalls, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  // Cooling range is cool 19-30 widened to auto 17-30, so 17-30.
  await handler.setCoolingThresholdTemperature(17); // at the bottom edge, not a whole °F
  await handler.setCoolingThresholdTemperature(33); // above the top
  const sent = sendCommandCalls.map((c) => c.commands.spCool);
  assert.strictEqual(sent[0], 17.3, '17°C is 62.6°F; the first whole °F at or above 17 is 63°F = 17.3');
  assert.strictEqual(sent[1], 30, '86°F = 30°C exactly');
});

// ---- Ranges from the device profile --------------------------------------

test('each threshold gets its own mode\'s range, widened to auto', () => {
  const { accessory, applyProfile } = makeHarness();
  applyProfile(profile());
  assert.deepStrictEqual(charProps(accessory, 'HeatingThresholdTemperature'),
    { minValue: 16, maxValue: 31, minStep: 0.1 });
  assert.deepStrictEqual(charProps(accessory, 'CoolingThresholdTemperature'),
    { minValue: 17, maxValue: 30, minStep: 0.1 });
});

test('the mode picker offers only what the unit can do', () => {
  const T = Characteristic.TargetHeaterCoolerState;
  const withHeat = makeHarness();
  withHeat.applyProfile(profile());
  assert.deepStrictEqual(charProps(withHeat.accessory, 'TargetHeaterCoolerState').validValues,
    [T.AUTO, T.HEAT, T.COOL]);

  const coolOnly = makeHarness();
  coolOnly.applyProfile(profile({ hasModeHeat: false }));
  assert.deepStrictEqual(charProps(coolOnly.accessory, 'TargetHeaterCoolerState').validValues, [T.COOL]);
});

// ---- Powered-off guard (inherits the 1.5.2 behavior) ---------------------

test('threshold writes to a powered-off unit are cached, not sent', async () => {
  const { handler, sendCommandCalls } = makeHarness();
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));
  await handler.setHeatingThresholdTemperature(22.3);
  assert.strictEqual(sendCommandCalls.length, 0,
    'no bare setpoint is sent to an off unit (would 400 modeRequiredWhenDeviceOff)');
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 22.3, 'cached + echoed so the handle holds');
});

test('the tile keeps the whole-°F value after HomeKit stores the raw written one', async () => {
  // hap-nodejs stores the value as sent after onSet resolves (22.0), over the
  // quantized echo (22.3). The plugin re-pushes on a later tick.
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await handler.setCoolingThresholdTemperature(22.0);
  heaterCooler(accessory).getCharacteristic(Characteristic.CoolingThresholdTemperature).value = 22.0;
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(charValue(accessory, 'CoolingThresholdTemperature'), 22.3);
});
