'use strict';

// Fields a cloud zone poll doesn't carry must survive it.
//
// `GET /sites/{id}/zones` sends fanSpeed and airDirection as null and has no
// displayConfig at all (filter, defrost, standby). processZoneUpdate used to rebuild
// the status object from the poll alone, so every poll:
//  - flipped fanSpeed between the streamed value and null. The mirror signature
//    includes fan speed, so alternating poll/streaming updates read as a source
//    change and fired a push;
//  - cleared the filter-dirty flag and standby until the next streaming update.
//
// Also: the humidity getter used to fetch GET /devices/{serial}/status when nothing
// was cached and store it AS the unit's status. That endpoint returns firmware and
// Wi-Fi fields, so every other getter then read a record with no mode or roomTemp.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeLog, makeAccessory } = require('./helpers');

const SERIAL = 'TESTSERIAL001';

function makeHarness() {
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    localClient: { hasLocal: () => false, sendCommand: async () => true },
  };
  let stream = null;
  const kumoAPI = {
    subscribeToDevice(_serial, cb) { stream = cb; },
    onDeviceProfileUpdate() {},
    sendCommand: async () => true,
    getDeviceStatus: async () => {
      throw new Error('getDeviceStatus must not be called from a getter');
    },
  };
  const handler = new KumoThermostatAccessory(platform, makeAccessory('Kitchen', SERIAL), kumoAPI, 30);
  return { handler, stream: (data) => stream(SERIAL, data) };
}

const poll = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: null, airDirection: null,
    roomTemp: 25, spCool: 23, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

const streamed = (over = {}) => ({
  id: 'zone-1', deviceSerial: SERIAL, power: 1, operationMode: 'cool',
  roomTemp: 25, spCool: 23, spHeat: 20, spAuto: null, humidity: null,
  fanSpeed: 'quiet', airDirection: 'swing',
  displayConfig: { filter: true, defrost: false, standby: true, hotAdjust: false },
  ...over,
});

test('a cloud poll keeps the fan speed and vane that streaming reported', () => {
  const { handler, stream } = makeHarness();
  stream(streamed());
  handler.updateFromZone(poll());
  assert.strictEqual(handler.currentStatus.fanSpeed, 'quiet');
  assert.strictEqual(handler.currentStatus.airDirection, 'swing');
});

test('a cloud poll keeps the filter, standby and model streaming reported', () => {
  const { handler, stream } = makeHarness();
  stream(streamed({ modelNumber: 'SVZ-KP30NA' }));
  handler.updateFromZone(poll());
  assert.strictEqual(handler.currentStatus.filterDirty, true);
  assert.strictEqual(handler.currentStatus.standby, true);
  assert.strictEqual(handler.currentStatus.defrost, false);
  assert.strictEqual(handler.currentStatus.modelNumber, 'SVZ-KP30NA');
});

test('status listeners (the mirror) see a steady fan speed across poll/stream alternation', () => {
  const { handler, stream } = makeHarness();
  const seen = [];
  handler.onStatusUpdate((s) => seen.push(s.fanSpeed));
  stream(streamed());
  handler.updateFromZone(poll());
  stream(streamed());
  handler.updateFromZone(poll());
  assert.ok(seen.length >= 4, `expected a notification per update, got ${seen.length}`);
  assert.deepStrictEqual([...new Set(seen)], ['quiet']);
});

test('a streaming update that omits fan speed keeps the last known one', () => {
  const { handler, stream } = makeHarness();
  stream(streamed({ fanSpeed: 'powerful' }));
  stream(streamed({ fanSpeed: undefined, airDirection: undefined }));
  assert.strictEqual(handler.currentStatus.fanSpeed, 'powerful');
  assert.strictEqual(handler.currentStatus.airDirection, 'swing');
});

test('with nothing ever reported, fan speed and vane default to auto', () => {
  const { handler } = makeHarness();
  handler.updateFromZone(poll());
  assert.strictEqual(handler.currentStatus.fanSpeed, 'auto');
  assert.strictEqual(handler.currentStatus.airDirection, 'auto');
});

test('a real fan change still comes through', () => {
  const { handler, stream } = makeHarness();
  stream(streamed({ fanSpeed: 'quiet' }));
  handler.updateFromZone(poll({ fanSpeed: 'powerful' }));
  assert.strictEqual(handler.currentStatus.fanSpeed, 'powerful');
});

test('the humidity getter serves the cache and never replaces the status', async () => {
  const { handler } = makeHarness();
  assert.strictEqual(await handler.getCurrentRelativeHumidity(), 0);
  assert.ok(!handler.currentStatus, 'no status invented from the /status endpoint');

  handler.updateFromZone(poll({ humidity: 48 }));
  assert.strictEqual(await handler.getCurrentRelativeHumidity(), 48);
  assert.strictEqual(handler.currentStatus.operationMode, 'cool');
});
