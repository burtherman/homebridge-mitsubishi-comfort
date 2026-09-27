'use strict';

// Moving from the 1.x Thermostat to the 2.0 HeaterCooler.
//
// - An accessory cached by 1.x carries a Thermostat service. It's removed on load,
//   or the unit would show two competing climate tiles. The UUID comes from the
//   serial, so the accessory itself (room, name) is kept.
// - The Dry and Fan switches keep their subtypes, so HomeKit automations on them
//   survive. They're on by default and can be turned off in config.
// - Humidity moves to a HumiditySensor service (HeaterCooler has no humidity
//   characteristic), on by default.
// - Mirroring updates the target's HeaterCooler tile, not Thermostat characteristics.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeAccessory } = require('./helpers');

const SERIAL = 'TESTSERIAL001';

function makeHarness({ accessory = makeAccessory('Kitchen', SERIAL), kumoConfig = {} } = {}) {
  const infos = [];
  const sent = [];
  let profileCb = null;
  const noop = () => {};
  const platform = {
    Service,
    Characteristic,
    kumoConfig,
    log: { info: (m) => infos.push(m), warn: noop, error: noop, debug: noop },
    api: { updatePlatformAccessories() {} },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand(serial, commands) {
      sent.push(commands);
      return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, infos, sent, applyProfile: (p) => profileCb(SERIAL, p) };
}

const profile = {
  numberOfFanSpeeds: 3, hasFanSpeedAuto: true, hasVaneDir: false, hasVaneSwing: false,
  hasModeDry: true, hasModeHeat: true, hasModeVent: true, hasDefrost: true, hasStandby: true,
  usesSetPointInDryMode: true,
  minimumSetPoints: { heat: 16, cool: 19, auto: 17 },
  maximumSetPoints: { heat: 31, cool: 30, auto: 30 },
};

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 24, spCool: 23, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

test('a cached 1.x Thermostat service is replaced by a HeaterCooler', () => {
  const accessory = makeAccessory('Kitchen', SERIAL);
  accessory.addService(Service.Thermostat, 'Kitchen');
  const { infos } = makeHarness({ accessory });
  assert.strictEqual(accessory.getService(Service.Thermostat), null, 'old tile removed');
  assert.ok(accessory.getService(Service.HeaterCooler), 'new tile added');
  assert.ok(infos.some((m) => /migrated Thermostat -> HeaterCooler/.test(m)), 'the migration is logged');
});

test('cached Dry and Fan switches are kept across the migration', () => {
  const accessory = makeAccessory('Kitchen', SERIAL);
  accessory.addService(Service.Thermostat, 'Kitchen');
  const dry = accessory.addService(Service.Switch, 'Kitchen Dry', 'dry');
  const fan = accessory.addService(Service.Switch, 'Kitchen Fan', 'fan-only');
  const { applyProfile } = makeHarness({ accessory });
  applyProfile(profile);
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), dry, 'same Dry switch service');
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-only'), fan, 'same Fan switch service');
});

test('the Dry and Fan switches can be turned off in config', () => {
  const { accessory, applyProfile } = makeHarness({ kumoConfig: { showDrySwitch: false, showFanOnlySwitch: false } });
  applyProfile(profile);
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'dry'), null);
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'fan-only'), null);
});

test('humidity is a HumiditySensor service', async () => {
  const { handler, accessory } = makeHarness();
  handler.updateFromZone(zone({ humidity: 48 }));
  const sensor = accessory.getService(Service.HumiditySensor);
  assert.ok(sensor, 'HumiditySensor added on the first reading');
  assert.strictEqual(sensor.getCharacteristic(Characteristic.CurrentRelativeHumidity).value, 48);
  assert.strictEqual(await handler.getCurrentRelativeHumidity(), 48);
});

test('showHumiditySensor: false adds no sensor and removes a cached one', () => {
  const off = makeHarness({ kumoConfig: { showHumiditySensor: false } });
  off.handler.updateFromZone(zone({ humidity: 48 }));
  assert.strictEqual(off.accessory.getService(Service.HumiditySensor), null);

  const accessory = makeAccessory('Kitchen', SERIAL);
  accessory.addService(Service.HumiditySensor, 'Kitchen Humidity');
  makeHarness({ accessory, kumoConfig: { showHumiditySensor: false } });
  assert.strictEqual(accessory.getService(Service.HumiditySensor), null, 'cached sensor dropped');
});

test('a mirror push updates the target\'s HeaterCooler tile', async () => {
  const { handler, accessory, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.applyMirror({ operationMode: 'heat', power: 1, spHeat: 22.3, spCool: 24, fanSpeed: 'auto' });
  assert.deepStrictEqual(sent, [{ operationMode: 'heat', spHeat: 22.3, fanSpeedRaw: 'auto' }]);
  const tile = accessory.getService(Service.HeaterCooler);
  assert.strictEqual(tile.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
  assert.strictEqual(tile.getCharacteristic(Characteristic.TargetHeaterCoolerState).value,
    Characteristic.TargetHeaterCoolerState.HEAT);
  assert.strictEqual(tile.getCharacteristic(Characteristic.HeatingThresholdTemperature).value, 22.3);
});

test('a mirror push also becomes the target\'s power-on mode', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool', power: 1 }));
  await handler.applyMirror({ operationMode: 'heat', power: 1, spHeat: 22.3, spCool: 24, fanSpeed: '' });
  await handler.applyMirror({ operationMode: 'off', power: 0, spHeat: 22.3, spCool: 24, fanSpeed: '' });
  sent.length = 0;
  await handler.setActive(Characteristic.Active.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});
