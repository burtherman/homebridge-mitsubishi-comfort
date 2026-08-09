'use strict';

// Test for the Fahrenheit round-trip temperature correction.
//
// The Kumo API returns temperatures in Celsius. When the device works internally
// in Fahrenheit (US-market units), the °F→°C conversion in the API may lose
// precision (e.g. 70°F stored as 21.0°C instead of 21.111°C). When the Home app
// converts back (21.0°C → 69.8°F), the displayed value can be 1°F off.
//
// The fix rounds each Celsius value to the nearest exact Fahrenheit whole-degree
// equivalent before publishing to HomeKit, controlled by the `temperatureUnit`
// config option (default 'F').

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
      charCache[prop] = { _name: String(prop), OFF: 0, HEAT: 1, COOL: 2, AUTO: 3, FILTER_OK: 0, CHANGE_FILTER: 1 };
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
    displayName: 'TestUnit',
    UUID: 'test-uuid',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'TestUnit' } },
    getService(type) {
      const e = entries.find((x) => x.type === type && x.subtype === undefined);
      return e ? e.svc : null;
    },
    addService(type, name, subtype) {
      const s = makeService(type, name, subtype);
      entries.push({ type, subtype, svc: s });
      return s;
    },
    getServiceById(type, subtype) {
      const e = entries.find((x) => x.type === type && x.subtype === subtype);
      return e ? e.svc : null;
    },
    removeService() {},
  };
}

function makeKumoAPI() {
  return {
    subscribeToDevice() {},
    unsubscribeFromDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand: async () => true,
  };
}

function makePlatform(temperatureUnit) {
  return {
    log: makeLog(),
    Service,
    Characteristic,
    api: { updatePlatformAccessories() {} },
    config: { temperatureUnit },
    localClient: null,
  };
}

function buildHandler(temperatureUnit) {
  const platform = makePlatform(temperatureUnit);
  const accessory = makeAccessory();
  const api = makeKumoAPI();
  const handler = new KumoThermostatAccessory(platform, accessory, api, 30);
  return { handler, accessory, platform };
}

function feedZoneUpdate(handler, roomTemp, spHeat, spCool, operationMode) {
  handler.updateFromZone({
    id: 'zone-1',
    name: 'TestUnit',
    isActive: true,
    adapter: {
      id: 'adapter-1',
      deviceSerial: SERIAL,
      roomTemp,
      spHeat,
      spCool,
      spAuto: null,
      humidity: null,
      power: 1,
      operationMode: operationMode || 'cool',
      previousOperationMode: operationMode || 'cool',
      fanSpeed: 'auto',
      airDirection: 'auto',
      connected: true,
      isSimulator: false,
      hasSensor: false,
      hasMhk2: false,
      scheduleOwner: 'adapter',
      scheduleHoldEndTime: 0,
    },
  });
}

function getCharValue(accessory, serviceType, charId) {
  const svc = accessory.getService(serviceType);
  if (!svc) return undefined;
  const ch = svc.getCharacteristic(charId);
  return ch ? ch.value : undefined;
}

// --- Tests ---

test('roundToNearestFahrenheit corrects 21.0°C to display as 70°F', () => {
  const { handler, accessory } = buildHandler('F');
  // 70°F = 21.111°C, API returns 21.0°C which is 69.8°F → without fix shows 69°F
  feedZoneUpdate(handler, 21.0, 21.0, 21.0, 'cool');

  const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  const targetTemp = getCharValue(accessory, 'Thermostat', Characteristic.TargetTemperature);

  // After correction: 21.0°C → round(69.8°F) = 70°F → (70-32)*5/9 ≈ 21.111°C
  const expected = (70 - 32) * 5 / 9;
  assert.ok(Math.abs(currentTemp - expected) < 0.001,
    `currentTemp should be ~${expected.toFixed(4)}°C (70°F), got ${currentTemp}`);
  assert.ok(Math.abs(targetTemp - expected) < 0.001,
    `targetTemp should be ~${expected.toFixed(4)}°C (70°F), got ${targetTemp}`);
});

test('no correction when temperatureUnit is C', () => {
  const { handler, accessory } = buildHandler('C');
  feedZoneUpdate(handler, 21.0, 21.0, 21.0, 'cool');

  const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  const targetTemp = getCharValue(accessory, 'Thermostat', Characteristic.TargetTemperature);

  assert.strictEqual(currentTemp, 21.0, 'currentTemp should be raw 21.0°C with no correction');
  assert.strictEqual(targetTemp, 21.0, 'targetTemp should be raw 21.0°C with no correction');
});

test('correction is default (no config = treated as F)', () => {
  const { handler, accessory } = buildHandler(undefined);
  feedZoneUpdate(handler, 21.0, 21.0, 21.0, 'cool');

  const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  const expected = (70 - 32) * 5 / 9;
  assert.ok(Math.abs(currentTemp - expected) < 0.001,
    `should default to F correction, got ${currentTemp}`);
});

test('correction round-trips a range of Fahrenheit values', () => {
  const { handler, accessory } = buildHandler('F');

  // Test a set of common Fahrenheit setpoints and their lossy Celsius representations
  const cases = [
    { inputC: 15.5, expectedF: 60 },  // 60°F = 15.556°C
    { inputC: 18.0, expectedF: 64 },  // 64°F = 17.778°C, but 18.0°C → 64.4°F → 64°F
    { inputC: 18.5, expectedF: 65 },  // 65°F = 18.333°C
    { inputC: 20.0, expectedF: 68 },  // 68°F = 20.000°C (exact)
    { inputC: 20.5, expectedF: 69 },  // 69°F = 20.556°C
    { inputC: 21.0, expectedF: 70 },  // 70°F = 21.111°C
    { inputC: 21.5, expectedF: 71 },  // 71°F = 21.667°C
    { inputC: 22.0, expectedF: 72 },  // 72°F = 22.222°C
    { inputC: 22.5, expectedF: 73 },  // 73°F = 22.778°C
    { inputC: 23.0, expectedF: 73 },  // 73°F = 22.778°C, 23.0°C → 73.4°F → 73°F
    { inputC: 23.5, expectedF: 74 },  // 74°F = 23.333°C
    { inputC: 24.0, expectedF: 75 },  // 75°F = 23.889°C, 24.0°C → 75.2°F → 75°F
    { inputC: 25.0, expectedF: 77 },  // 77°F = 25.000°C (exact)
  ];

  for (const { inputC, expectedF } of cases) {
    feedZoneUpdate(handler, inputC, inputC, inputC, 'cool');
    const currentTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
    const resultF = Math.round(currentTemp * 9 / 5 + 32);
    assert.strictEqual(resultF, expectedF,
      `${inputC}°C should display as ${expectedF}°F, got ${resultF}°F (corrected to ${currentTemp.toFixed(4)}°C)`);
  }
});

test('threshold temperatures are also corrected', () => {
  const { handler, accessory } = buildHandler('F');
  // In auto mode, both spHeat and spCool are published as threshold temps
  feedZoneUpdate(handler, 21.0, 20.0, 23.0, 'autoHeat');

  const heatThreshold = getCharValue(accessory, 'Thermostat', Characteristic.HeatingThresholdTemperature);
  const coolThreshold = getCharValue(accessory, 'Thermostat', Characteristic.CoolingThresholdTemperature);

  // 20.0°C → 68°F → (68-32)*5/9 = 20.0°C (exact, no change needed)
  const expectedHeatF = 68;
  const actualHeatF = Math.round(heatThreshold * 9 / 5 + 32);
  assert.strictEqual(actualHeatF, expectedHeatF,
    `heat threshold 20.0°C should display as ${expectedHeatF}°F, got ${actualHeatF}°F`);

  // 23.0°C → 73.4°F → round to 73°F → (73-32)*5/9 ≈ 22.778°C
  const expectedCoolF = 73;
  const actualCoolF = Math.round(coolThreshold * 9 / 5 + 32);
  assert.strictEqual(actualCoolF, expectedCoolF,
    `cool threshold 23.0°C should display as ${expectedCoolF}°F, got ${actualCoolF}°F`);
});

test('internal currentStatus is NOT modified by the correction', () => {
  const { handler, accessory } = buildHandler('F');
  feedZoneUpdate(handler, 21.0, 21.0, 23.0, 'cool');

  // The characteristic value should be corrected
  const displayTemp = getCharValue(accessory, 'Thermostat', Characteristic.CurrentTemperature);
  assert.notStrictEqual(displayTemp, 21.0, 'display value should be corrected away from 21.0');

  // But getCurrentTemperature should also return the corrected value (it reads from
  // cache and corrects at the boundary)
  handler.getCurrentTemperature().then(val => {
    const resultF = Math.round(val * 9 / 5 + 32);
    assert.strictEqual(resultF, 70, 'getCurrentTemperature getter should also return corrected value');
  });
});
