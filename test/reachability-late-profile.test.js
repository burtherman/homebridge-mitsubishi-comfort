'use strict';

// An offline unit must stay No Response even when things arrive after it's marked
// offline. Found live on the 2.0 rollout (2026-09-27): the rear bedroom's adapter was
// offline, the plugin pushed No Response at 20:53:58, then the device profile arrived
// and syncFanCharacteristics pushed the fan tile's power from the cloud's frozen
// "cool, on" record — the bridge's cache showed the fan Active and blowing air.
// Reads still returned No Response, but controllers also receive pushed values.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeLog, makeAccessory } = require('./helpers');

const SERIAL = 'REAR01';
const C = Characteristic;

class HapStatusError extends Error {
  constructor(status) { super(`HAP status ${status}`); this.hapStatus = status; }
}

function makeHarness() {
  let profileCb = null;
  let stream = null;
  const platform = {
    Service, Characteristic, log: makeLog(),
    api: { updatePlatformAccessories() {}, hap: { HapStatusError, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } },
    localClient: { hasLocal: () => false, sendCommand: async () => true },
  };
  const kumoAPI = {
    subscribeToDevice(_s, cb) { stream = cb; },
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand: async () => true,
  };
  const accessory = makeAccessory('Rear bedroom', SERIAL);
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return {
    handler, accessory,
    tile: accessory.getService(Service.HeaterCooler),
    fan: accessory.getServiceById(Service.Fanv2, 'airflow'),
    applyProfile: (p) => profileCb(SERIAL, p),
    stream: (d) => stream(SERIAL, d),
  };
}

const profile = {
  numberOfFanSpeeds: 3, hasFanSpeedAuto: true, hasVaneDir: true, hasVaneSwing: true,
  hasModeDry: true, hasModeHeat: true, hasModeVent: true, hasDefrost: true, hasStandby: true,
  usesSetPointInDryMode: true,
  minimumSetPoints: { heat: 17, cool: 19, auto: 17 },
  maximumSetPoints: { heat: 28, cool: 30, auto: 30 },
};

// The frozen shadow record the cloud keeps serving for an offline adapter.
const frozen = {
  id: 'z', deviceSerial: SERIAL, power: 1, operationMode: 'cool', roomTemp: 26.5,
  spHeat: 20, spCool: 24, spAuto: null, humidity: 55, fanSpeed: 'quiet', airDirection: 'auto',
  displayConfig: { filter: true, defrost: false, standby: false, hotAdjust: false },
};

const isErr = (v) => v instanceof Error;

test('a profile and a frozen record arriving after the unit went offline publish nothing', () => {
  const { handler, tile, fan, accessory, applyProfile, stream } = makeHarness();
  handler.setCloudConnected(false);     // reported offline first (20:53:58)
  stream(frozen);                       // the cloud replays its frozen record
  applyProfile(profile);                // then the profile arrives

  for (const key of ['Active', 'CurrentHeaterCoolerState', 'TargetHeaterCoolerState', 'CurrentTemperature',
    'HeatingThresholdTemperature', 'CoolingThresholdTemperature', 'SwingMode']) {
    assert.ok(isErr(tile.getCharacteristic(C[key]).value), `tile ${key} still No Response`);
  }
  for (const key of ['Active', 'CurrentFanState', 'RotationSpeed', 'TargetFanState']) {
    assert.ok(isErr(fan.getCharacteristic(C[key]).value), `fan ${key} still No Response (was ACTIVE from the frozen record)`);
  }
  for (const sub of ['dry', 'fan-only']) {
    const sw = accessory.getServiceById(Service.Switch, sub);
    assert.ok(sw && isErr(sw.getCharacteristic(C.On).value), `${sub} switch still No Response`);
  }
  const humidity = accessory.getService(Service.HumiditySensor);
  assert.ok(humidity && isErr(humidity.getCharacteristic(C.CurrentRelativeHumidity).value), 'humidity No Response');
  const filter = accessory.getService(Service.FilterMaintenance);
  assert.ok(filter && isErr(filter.getCharacteristic(C.FilterChangeIndication).value), 'filter No Response');
});

test('recovery republishes everything after a late profile', () => {
  const { handler, tile, fan, applyProfile, stream } = makeHarness();
  handler.setCloudConnected(false);
  stream(frozen);
  applyProfile(profile);
  handler.setCloudConnected(true);
  assert.strictEqual(tile.getCharacteristic(C.Active).value, C.Active.ACTIVE);
  assert.strictEqual(fan.getCharacteristic(C.RotationSpeed).value, 25);
  assert.strictEqual(tile.getCharacteristic(C.CoolingThresholdTemperature).value, 24);
});
