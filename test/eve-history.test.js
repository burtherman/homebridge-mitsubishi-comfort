'use strict';

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

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 24, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

class FakeHistoryService {
  constructor(type, accessory, opts) {
    this.type = type;
    this.accessory = accessory;
    this.opts = opts;
    this.entries = [];
  }

  addEntry(entry) {
    this.entries.push(entry);
  }
}

function makeFakeGatoFactory() {
  const instances = [];
  const factory = function (type, accessory, opts) {
    const svc = new FakeHistoryService(type, accessory, opts);
    instances.push(svc);
    return svc;
  };
  factory.instances = instances;
  return factory;
}

function makeHarness({ enableHistory = false } = {}) {
  const fakeGatoFactory = makeFakeGatoFactory();
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    config: {},
    FakeGatoHistoryService: enableHistory ? fakeGatoFactory : null,
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand() { return Promise.resolve(true); },
  };
  const accessory = makeAccessory();
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  return { handler, accessory, fakeGatoFactory };
}

test('history service is created when FakeGatoHistoryService is available', () => {
  const { fakeGatoFactory } = makeHarness({ enableHistory: true });
  assert.strictEqual(fakeGatoFactory.instances.length, 1);
  assert.strictEqual(fakeGatoFactory.instances[0].type, 'room');
});

test('no history service when FakeGatoHistoryService is null', () => {
  const { fakeGatoFactory } = makeHarness({ enableHistory: false });
  assert.strictEqual(fakeGatoFactory.instances.length, 0);
});

test('zone update logs temperature to history', () => {
  const { handler, fakeGatoFactory } = makeHarness({ enableHistory: true });
  handler.updateFromZone(zone({ roomTemp: 22.5 }));

  const svc = fakeGatoFactory.instances[0];
  assert.strictEqual(svc.entries.length, 1);
  assert.strictEqual(svc.entries[0].temp, 22.5);
  assert.ok(svc.entries[0].time > 0, 'timestamp is set');
  assert.strictEqual(svc.entries[0].humidity, undefined, 'no humidity when null');
});

test('zone update logs humidity when available', () => {
  const { handler, fakeGatoFactory } = makeHarness({ enableHistory: true });
  handler.updateFromZone(zone({ roomTemp: 21, humidity: 55 }));

  const svc = fakeGatoFactory.instances[0];
  assert.strictEqual(svc.entries.length, 1);
  assert.strictEqual(svc.entries[0].temp, 21);
  assert.strictEqual(svc.entries[0].humidity, 55);
});

test('multiple updates accumulate history entries', () => {
  const { handler, fakeGatoFactory } = makeHarness({ enableHistory: true });
  handler.updateFromZone(zone({ roomTemp: 20 }));
  handler.updateFromZone(zone({ roomTemp: 21 }));
  handler.updateFromZone(zone({ roomTemp: 22 }));

  const svc = fakeGatoFactory.instances[0];
  assert.strictEqual(svc.entries.length, 3);
  assert.strictEqual(svc.entries[0].temp, 20);
  assert.strictEqual(svc.entries[1].temp, 21);
  assert.strictEqual(svc.entries[2].temp, 22);
});

test('no history entries when history is disabled', () => {
  const { handler, fakeGatoFactory } = makeHarness({ enableHistory: false });
  handler.updateFromZone(zone({ roomTemp: 22 }));
  assert.strictEqual(fakeGatoFactory.instances.length, 0);
});
