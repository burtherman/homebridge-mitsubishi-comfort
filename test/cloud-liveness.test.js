'use strict';

// A unit whose cloud link goes half-dead: the cloud still lists it as connected (no
// device_status_v2 "disconnected"), but commands never reach it. Found 2026-09-30 /
// 10-01 on the front bedroom (cloud-only, no working LAN key): 8 commands from
// HomeKit and the Comfort app were accepted and reported back as off, the Comfort app
// said "connected", and a power cycle at the breaker fixed it. For cloud-only units,
// two unconfirmed commands in a row, or two unanswered status requests in a row, now
// show No Response until the unit reports in again.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeAccessory } = require('./helpers');

const SERIAL = '0Y34P008Q100142F';
const C = Characteristic;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HapStatusError extends Error {
  constructor(status) { super(`HAP status ${status}`); this.hapStatus = status; }
}

function makeHarness({ local = null } = {}) {
  const logs = { info: [], warn: [] };
  const log = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error() {}, debug() {} };
  let stream = null;
  const sent = [];
  const kumoAPI = {
    lastUpdateAt: 0,
    lastUpdated: null,
    asked: [],
    subscribeToDevice(_s, cb) { stream = cb; },
    onDeviceProfileUpdate() {},
    sendCommand: async (_s, c) => { sent.push(c); return true; },
    requestDeviceStatus(serial) { this.asked.push(serial); },
    getLastDeviceUpdateAt() { return this.lastUpdateAt; },
    async getDeviceLastUpdated() { return this.lastUpdated; },
  };
  const platform = {
    Service, Characteristic, log,
    api: { updatePlatformAccessories() {}, hap: { HapStatusError, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } },
    localClient: local,
  };
  const handler = new KumoThermostatAccessory(platform, makeAccessory('Front bedroom', SERIAL), kumoAPI, 30);
  clearInterval(handler.livenessTimer);
  handler.CLOUD_SYNC_WATCH_MS = 15;
  const update = (over = {}) => stream(SERIAL, {
    id: 'z', deviceSerial: SERIAL, power: 0, operationMode: 'off', roomTemp: 23.5, spHeat: 20, spCool: 22.3,
    spAuto: null, humidity: null, fanSpeed: 'auto', airDirection: 'auto', ...over,
  });
  update();
  return { handler, kumoAPI, sent, logs, update };
}

const turnOn = async (handler) => {
  await handler.setTargetHeaterCoolerState(C.TargetHeaterCoolerState.COOL);
  await sleep(5);
};

test('two cloud commands the cloud never confirms mark the unit No Response', async () => {
  const { handler, sent, logs } = makeHarness();
  await turnOn(handler);
  await sleep(30);
  assert.strictEqual(sent.length, 1);
  assert.ok(handler.isReachable(), 'one miss is not enough');

  await turnOn(handler);
  await sleep(30);
  assert.strictEqual(handler.isReachable(), false);
  await assert.rejects(handler.getActive(), 'reads throw No Response');
  assert.ok(logs.warn.some((m) => m.includes('not responding') && m.includes('last two commands')));
});

test('a command reverted by the cloud and retried counts as unconfirmed', async () => {
  const { handler, update } = makeHarness();
  handler.CLOUD_SYNC_WATCH_MS = 1000;
  await turnOn(handler);
  update({ power: 0, operationMode: 'off' });        // the cloud says off again
  await turnOn(handler);                             // the owner tries again
  update({ power: 0, operationMode: 'off' });
  await turnOn(handler);                             // and again
  assert.strictEqual(handler.isReachable(), false);
});

test('a quick change of mind on a working unit is not counted', async () => {
  const { handler } = makeHarness();
  handler.CLOUD_SYNC_WATCH_MS = 1000;
  await turnOn(handler);
  await handler.setTargetHeaterCoolerState(C.TargetHeaterCoolerState.HEAT);
  await sleep(5);
  await handler.setTargetHeaterCoolerState(C.TargetHeaterCoolerState.COOL);
  await sleep(5);
  assert.ok(handler.isReachable());
});

test('a confirmed command resets the count', async () => {
  const { handler, update } = makeHarness();
  await turnOn(handler);
  await sleep(30);                                   // miss 1
  handler.CLOUD_SYNC_WATCH_MS = 1000;
  await handler.setTargetHeaterCoolerState(C.TargetHeaterCoolerState.HEAT);
  await sleep(5);
  update({ power: 1, operationMode: 'heat' });       // confirmed
  handler.CLOUD_SYNC_WATCH_MS = 15;
  await turnOn(handler);
  await sleep(30);                                   // miss again, but only 1 in a row
  assert.ok(handler.isReachable());
});

test('after unconfirmed commands, a frozen reading does not clear it but a new one does', async () => {
  const { handler, update, logs } = makeHarness();
  await turnOn(handler); await sleep(30);
  await turnOn(handler); await sleep(30);
  assert.strictEqual(handler.isReachable(), false);

  update({ roomTemp: 23.5 });                        // the cloud's frozen copy
  assert.strictEqual(handler.isReachable(), false);
  update({ roomTemp: 22 });                          // a real new reading
  assert.ok(handler.isReachable());
  assert.ok(logs.info.some((m) => m.includes('responding again')));
});

test('a late confirmation of the last command clears it', async () => {
  const { handler, update } = makeHarness();
  await turnOn(handler); await sleep(30);
  await turnOn(handler); await sleep(30);
  assert.strictEqual(handler.isReachable(), false);
  update({ power: 1, operationMode: 'cool' });
  assert.ok(handler.isReachable());
});

test('the adapter reporting to the cloud again clears it', async () => {
  const { handler, kumoAPI } = makeHarness();
  await turnOn(handler); await sleep(30);
  await turnOn(handler); await sleep(30);
  kumoAPI.lastUpdated = Date.now() - 60000;          // before it was marked: nothing
  await handler.checkLiveness();
  assert.strictEqual(handler.isReachable(), false);
  kumoAPI.lastUpdated = Date.now() + 1000;           // after: it's back
  await handler.checkLiveness();
  assert.ok(handler.isReachable());
});

test('two unanswered status requests mark it No Response; an answer clears it', async () => {
  const { handler, kumoAPI, update } = makeHarness();
  kumoAPI.lastUpdateAt = Date.now() - 10 * 60 * 1000;   // quiet for 10 minutes
  await handler.checkLiveness();                          // asks
  assert.deepStrictEqual(kumoAPI.asked, [SERIAL]);
  await sleep(2);
  await handler.checkLiveness();                          // miss 1, asks again
  await sleep(2);
  assert.ok(handler.isReachable());
  await handler.checkLiveness();                          // miss 2
  assert.strictEqual(handler.isReachable(), false);

  update({ roomTemp: 23.5 });                             // it answers
  assert.ok(handler.isReachable());
});

test('a unit heard from recently is not asked', async () => {
  const { handler, kumoAPI } = makeHarness();
  kumoAPI.lastUpdateAt = Date.now() - 60000;
  await handler.checkLiveness();
  assert.deepStrictEqual(kumoAPI.asked, []);
});

test('an answered request resets the misses', async () => {
  const { handler, kumoAPI } = makeHarness();
  kumoAPI.lastUpdateAt = Date.now() - 10 * 60 * 1000;
  await handler.checkLiveness();                          // asks
  kumoAPI.lastUpdateAt = Date.now() + 1;                  // answered
  await handler.checkLiveness();
  assert.strictEqual(handler.probeMisses, 0);
  assert.ok(handler.isReachable());
});

test('units on the LAN are never probed or marked No Response; the cloud link only gets a warning', async () => {
  const local = { calls: [], hasLocal: () => true, sendCommand(s, c) { this.calls.push(c); return Promise.resolve(true); } };
  const { handler, kumoAPI, logs } = makeHarness({ local });
  kumoAPI.lastUpdateAt = Date.now() - 10 * 60 * 1000;
  await handler.checkLiveness();
  await handler.checkLiveness();
  await handler.checkLiveness();
  assert.deepStrictEqual(kumoAPI.asked, []);

  handler.CLOUD_SYNC_DELAY_MS = 1;
  for (let i = 0; i < 3; i += 1) {
    await turnOn(handler);
    await handler.setActive(C.Active.INACTIVE);
    await sleep(30);
  }
  assert.ok(handler.isReachable());
  assert.strictEqual(logs.warn.filter((m) => m.includes('[CLOUD LINK]') && m.includes('Comfort app')).length, 1);
});
