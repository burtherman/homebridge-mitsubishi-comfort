'use strict';

// Found on the 2.0 rollout (2026-09-27): on units upgraded from 1.x, the Home app drew
// each unit's combined tile as a switch ("All Off"), even at the large size. Marking the
// HeaterCooler primary and linking the switches to it didn't change that. The
// HeaterCooler was the last service in the list, added after the cached Dry and Fan
// Only switches; 1.x's Thermostat came first and drew correctly. Uses the real
// PlatformAccessory and hap-nodejs so the order and instance IDs are the ones HAP
// publishes.

const test = require('node:test');
const assert = require('node:assert');
const hap = require('hap-nodejs');
const { IdentifierCache } = require('hap-nodejs/dist/lib/model/IdentifierCache');
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TILE01';
const noop = () => {};

function makeUpgradedAccessory() {
  // The 1.x cache: Thermostat first, then the switches and the filter.
  const accessory = new PlatformAccessory('Kitchen', hap.uuid.generate(SERIAL));
  accessory.context.device = { deviceSerial: SERIAL, siteId: 's', displayName: 'Kitchen' };
  accessory.addService(hap.Service.Thermostat, 'Kitchen');
  accessory.addService(hap.Service.Switch, 'Kitchen Fan', 'fan-only');
  accessory.addService(hap.Service.Switch, 'Kitchen Dry', 'dry');
  accessory.addService(hap.Service.FilterMaintenance, 'Kitchen Filter');
  return accessory;
}

function construct(accessory) {
  const platform = {
    Service: hap.Service, Characteristic: hap.Characteristic, kumoConfig: {},
    log: { info: noop, warn: noop, error: noop, debug: noop },
    api: { hap, updatePlatformAccessories() {} }, localClient: null,
  };
  const kumoAPI = { subscribeToDevice() {}, onDeviceProfileUpdate() {}, sendCommand: async () => true };
  return new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
}

test('an upgraded unit publishes the HeaterCooler right after AccessoryInformation', () => {
  const accessory = makeUpgradedAccessory();
  construct(accessory);
  const order = accessory.services.map((s) => s.UUID);
  assert.strictEqual(order[0], hap.Service.AccessoryInformation.UUID);
  assert.strictEqual(order[1], hap.Service.HeaterCooler.UUID, 'HeaterCooler second, before the switches');
  assert.ok(!order.includes(hap.Service.Thermostat.UUID), 'the 1.x Thermostat is gone');
});

test('moving the HeaterCooler leaves every instance ID unchanged', () => {
  // Same accessory and cache, published once in the order it was added and once
  // after the move. The switches must keep their IDs, or automations bound to them break.
  const cache = new IdentifierCache('tile-order-ids');
  const idsFor = (accessory) => {
    const bridge = new hap.Bridge('Test bridge', hap.uuid.generate('tile-order-bridge-2'));
    bridge.addBridgedAccessory(accessory._associatedHAPAccessory);
    bridge._assignIDs(cache);
    return new Map(accessory._associatedHAPAccessory.services.map((s) => [`${s.UUID}|${s.subtype ?? ''}`, s.iid]));
  };

  const before = makeUpgradedAccessory();
  before.removeService(before.getService(hap.Service.Thermostat));
  before.addService(hap.Service.HeaterCooler, 'Kitchen');
  const beforeIds = idsFor(before);

  const after = makeUpgradedAccessory();
  construct(after);
  const afterIds = idsFor(after);

  for (const key of [`${hap.Service.Switch.UUID}|fan-only`, `${hap.Service.Switch.UUID}|dry`,
    `${hap.Service.HeaterCooler.UUID}|`]) {
    assert.ok(beforeIds.has(key) && afterIds.has(key), `${key} published both times`);
    assert.strictEqual(afterIds.get(key), beforeIds.get(key), `${key} keeps its instance ID`);
  }
});

test('a HeaterCooler that is already second is left alone', () => {
  const accessory = new PlatformAccessory('Kitchen', hap.uuid.generate('TILE02'));
  accessory.context.device = { deviceSerial: 'TILE02', siteId: 's', displayName: 'Kitchen' };
  construct(accessory);
  const first = accessory.services.map((s) => s.UUID);
  construct(accessory);
  assert.deepStrictEqual(accessory.services.map((s) => s.UUID), first);
  assert.strictEqual(first[1], hap.Service.HeaterCooler.UUID);
});
