'use strict';

// The shared fakes in test/helpers.js must carry hap-nodejs's real enum values.
// The per-file fakes they replace gave every characteristic AUTO=3, which is only
// true of TargetHeatingCoolingState; a test using the wrong constant still passed.

const test = require('node:test');
const assert = require('node:assert');
const { Characteristic, makeAccessory, Service } = require('./helpers');

test('enum values come from hap-nodejs, per characteristic', () => {
  assert.strictEqual(Characteristic.TargetHeatingCoolingState.AUTO, 3);
  assert.strictEqual(Characteristic.TargetHeaterCoolerState.AUTO, 0);
  assert.strictEqual(Characteristic.TargetHeaterCoolerState.COOL, 2);
  assert.strictEqual(Characteristic.TargetFanState.AUTO, 1);
  assert.strictEqual(Characteristic.Active.ACTIVE, 1);
  assert.strictEqual(Characteristic.CurrentHeaterCoolerState.IDLE, 1);
});

test('TargetHeaterCoolerState has no OFF: only Active expresses off', () => {
  assert.strictEqual(Characteristic.TargetHeaterCoolerState.OFF, undefined);
  assert.strictEqual(Characteristic.Active.INACTIVE, 0);
});

test('a name hap-nodejs does not define has no members', () => {
  assert.strictEqual(Characteristic.NotARealCharacteristic.AUTO, undefined);
});

test('identifiers are stable, so they work as Map keys', () => {
  assert.strictEqual(Characteristic.Active, Characteristic.Active);
  const acc = makeAccessory();
  const svc = acc.addService(Service.HeaterCooler, 'Kitchen');
  svc.updateCharacteristic(Characteristic.Active, 1);
  assert.strictEqual(svc.getCharacteristic(Characteristic.Active).value, 1);
  assert.strictEqual(acc.getService(Service.HeaterCooler), svc);
});
