'use strict';

// Shared HAP fakes for accessory tests.
//
// Portions derived from homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0,
// test/helpers.js @ 44fb5f5), modified: enum values are read from hap-nodejs
// instead of being copied by hand.
//
// Why derive them: the per-file fakes this replaces gave EVERY characteristic
// OFF:0 HEAT:1 COOL:2 AUTO:3. That's right for TargetHeatingCoolingState and wrong
// for nearly everything else — TargetHeaterCoolerState.AUTO is 0, TargetFanState.AUTO
// is 1, and TargetHeaterCoolerState has no OFF at all (only Active expresses off).
// A test that used the wrong constant would still pass against the fake.

// Homebridge 1.x depends on `hap-nodejs`; Homebridge 2 renamed it `@homebridge/hap-nodejs`.
function loadHap() {
  for (const name of ['hap-nodejs', '@homebridge/hap-nodejs']) {
    try {
      return require(name);
    } catch {
      // try the next name
    }
  }
  throw new Error('test/helpers.js: neither hap-nodejs nor @homebridge/hap-nodejs is installed');
}
const { Characteristic: RealCharacteristic } = loadHap();

/** The numeric enum members a real hap-nodejs characteristic class carries (e.g. AUTO, HEAT). */
function realEnumMembers(name) {
  const real = RealCharacteristic[name];
  if (typeof real !== 'function') {
    return {};
  }
  const members = {};
  for (const key of Object.getOwnPropertyNames(real)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(key) && typeof real[key] === 'number') {
      members[key] = real[key];
    }
  }
  return members;
}

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// Stable identifiers: the same object comes back for a given name, so it works as a
// Map key the way the real class does. A name hap-nodejs doesn't define gets no
// members, so a mistyped constant reads as undefined instead of silently matching.
const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) {
      charCache[prop] = { _name: String(prop), ...realEnumMembers(String(prop)) };
    }
    return charCache[prop];
  },
});

const Service = {
  AccessoryInformation: 'AccessoryInformation',
  Thermostat: 'Thermostat',
  HeaterCooler: 'HeaterCooler',
  Fanv2: 'Fanv2',
  Slats: 'Slats',
  HumiditySensor: 'HumiditySensor',
  Switch: 'Switch',
  FilterMaintenance: 'FilterMaintenance',
  Battery: 'Battery',
};

function makeCharacteristic() {
  const ch = {
    value: undefined,
    onGet() { return ch; },
    onSet() { return ch; },
    setProps(p) { ch.props = p; return ch; },
  };
  return ch;
}

function makeService(type, name, subtype) {
  const chars = new Map();
  const svc = {
    type, name, subtype,
    // Exposed so a test can ask whether a characteristic was ever added without adding
    // it by asking: real hap-nodejs getCharacteristic() ADDS an optional characteristic
    // as a side effect of the lookup.
    chars,
    getCharacteristic(id) {
      if (!chars.has(id)) {
        chars.set(id, makeCharacteristic());
      }
      return chars.get(id);
    },
    setCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    updateCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    // Primary/linked services, as hap-nodejs's Service has them.
    primary: false,
    linked: [],
    setPrimaryService(v = true) { svc.primary = v; },
    addLinkedService(other) { if (!svc.linked.includes(other)) svc.linked.push(other); },
  };
  return svc;
}

// AccessoryInformation is pre-seeded because the accessory constructor calls
// getService(...)! on it and would throw on null.
function makeAccessory(displayName = 'Kitchen', deviceSerial = 'TESTSERIAL001') {
  const entries = [
    { type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) },
  ];
  return {
    displayName,
    context: { device: { deviceSerial, siteId: 'site-1', displayName } },
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
      if (i >= 0) {
        entries.splice(i, 1);
      }
    },
  };
}

module.exports = { Characteristic, Service, makeLog, makeCharacteristic, makeService, makeAccessory, realEnumMembers };
