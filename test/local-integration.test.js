'use strict';

// Integration tests for local control wiring in the accessory:
//  - updateFromLocal() feeds a locally-read status into the characteristics
//  - local is authoritative: a cloud (polling/streaming) update is dropped while a
//    recent local poll exists (the cloud lags ~7-10s and would clobber it)
//  - sendDeviceCommand() prefers local and falls back to cloud on local failure

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTSERIAL001';

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// Real hap-nodejs enum values (see test/helpers.js). The old per-file fake gave
// every characteristic AUTO=3, which is only true of TargetHeatingCoolingState.
const { Characteristic } = require('./helpers');

const { Service } = require('./helpers');

function makeCharacteristic() {
  const ch = { value: undefined, onGet() { return ch; }, onSet() { return ch; }, setProps() { return ch; } };
  return ch;
}

function makeService(type, name, subtype) {
  const chars = new Map();
  const svc = {
    type, name, subtype,
    getCharacteristic(id) { if (!chars.has(id)) chars.set(id, makeCharacteristic()); return chars.get(id); },
    setCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
    updateCharacteristic(id, v) { svc.getCharacteristic(id).value = v; return svc; },
  };
  return svc;
}

function makeAccessory() {
  const entries = [{ type: Service.AccessoryInformation, subtype: undefined, svc: makeService(Service.AccessoryInformation) }];
  return {
    displayName: 'Kitchen',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Kitchen' } },
    getService(type) { const e = entries.find((x) => x.type === type && x.subtype === undefined); return e ? e.svc : null; },
    getServiceById(type, subtype) { const e = entries.find((x) => x.type === type && x.subtype === subtype); return e ? e.svc : null; },
    addService(type, name, subtype) { const svc = makeService(type, name, subtype); entries.push({ type, subtype, svc }); return svc; },
    removeService(svc) { const i = entries.findIndex((x) => x.svc === svc); if (i >= 0) entries.splice(i, 1); },
  };
}

function makeLocalClient(over = {}) {
  const calls = [];
  return {
    calls,
    hasLocalResult: true,
    sendCommandResult: true,
    hasLocal() { return this.hasLocalResult; },
    sendCommand(serial, commands) { calls.push({ serial, commands }); return Promise.resolve(this.sendCommandResult); },
    getStatus() { return Promise.resolve(null); },
    ...over,
  };
}

function makeHarness({ localClient = null } = {}) {
  const sendCommandCalls = [];
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
    localClient,
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate() {},
    sendCommand(serial, commands) { sendCommandCalls.push({ serial, commands }); return Promise.resolve(true); },
  };
  const handler = new KumoThermostatAccessory(platform, makeAccessory(), kumoAPI, 30);
  return { handler, sendCommandCalls, platform, kumoAPI };
}

const localStatus = (over = {}) => ({
  roomTemp: 24, operationMode: 'cool', power: 1, spCool: 23, spHeat: 20,
  spAuto: null, fanSpeed: 'auto', airDirection: 'auto', filterDirty: false,
  defrost: false, standby: false, ...over,
});

const cloudZone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 30, spCool: 28, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
});

// ---- updateFromLocal ------------------------------------------------------

test('updateFromLocal feeds a locally-read status into the characteristics', async () => {
  const { handler } = makeHarness();
  handler.updateFromLocal(localStatus({ roomTemp: 24, operationMode: 'cool', spCool: 23 }));

  assert.strictEqual(await handler.getCurrentTemperature(), 24);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 23, 'cool mode surfaces spCool');
});

// ---- a read that started before our command --------------------------------
//
// Found live 2026-09-27. The poller reads a unit's status, then its humidity, then
// applies both. A command queued on the unit's lock between those reads goes out
// first, and the pre-command status was then applied on top of it. At 21:10:52 the
// kitchen was turned off; at 21:10:54 its pre-off read landed, the tile flipped back
// to heat, and the mirror turned the living room back ON until the next poll.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a local read that started before our command is dropped when it lands after it', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat' }));
  const seen = [];
  handler.onStatusUpdate((s) => seen.push(s.operationMode));

  const readStartedAt = Date.now();
  await sleep(2);
  await handler.setActive(Characteristic.Active.INACTIVE);
  await sleep(20);
  assert.deepStrictEqual(local.calls.map((c) => c.commands.operationMode), ['off'], 'the off went out');

  // The read that was in flight when the off was sent: still says heat.
  handler.updateFromLocal(localStatus({ operationMode: 'heat' }), readStartedAt);

  assert.strictEqual(await handler.getActive(), Characteristic.Active.INACTIVE, 'tile stays off');
  assert.ok(!seen.slice(seen.indexOf('off')).includes('heat'), 'the mirror never sees the stale heat');
});

test('a local read that started after our command applies once the unit has settled', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });
  handler.COMMAND_SETTLE_MS = 10;
  handler.updateFromLocal(localStatus({ operationMode: 'heat' }));

  await handler.setActive(Characteristic.Active.INACTIVE);
  await sleep(20);
  // Someone turned it back on at the wall; this read started after the off.
  handler.updateFromLocal(localStatus({ operationMode: 'heat' }), Date.now());

  assert.strictEqual(await handler.getActive(), Characteristic.Active.ACTIVE);
});

// ---- the unit catching up with a command (2026-09-27) -----------------------
//
// A read that started a second AFTER the kitchen's off had finished still said heat:
// the unit reports its old state for a moment after accepting a command. The tile
// flipped back and the mirror pushed heat to the living room. The cloud had "off"
// 3.3s after the command.

test('a LAN read that still shows the old mode just after our command is ignored', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat' }));
  const seen = [];
  handler.onStatusUpdate((s) => seen.push(s.operationMode));

  await handler.setActive(Characteristic.Active.INACTIVE);
  await sleep(20);
  handler.updateFromLocal(localStatus({ operationMode: 'heat' }), Date.now());

  assert.strictEqual(await handler.getActive(), Characteristic.Active.INACTIVE, 'tile stays off');
  assert.ok(!seen.slice(seen.indexOf('off')).includes('heat'), 'the mirror never sees the stale heat');
});

test('a read that agrees with the command ends the wait, so a real change after it applies', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat' }));

  await handler.setActive(Characteristic.Active.INACTIVE);
  await sleep(20);
  handler.updateFromLocal(localStatus({ operationMode: 'off', power: 0 }), Date.now());
  handler.updateFromLocal(localStatus({ operationMode: 'cool' }), Date.now());   // the wall, right after

  assert.strictEqual(await handler.getActive(), Characteristic.Active.ACTIVE);
});

test('a setpoint read that has not caught up is ignored, and a matching one applies', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22.3);
  await sleep(2);   // a read stamped in the command's own millisecond counts as before it
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }), Date.now());
  assert.strictEqual(await handler.getHeatingThresholdTemperature(), 22.3, 'the old 20 is ignored');

  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 22.3, roomTemp: 25 }), Date.now());
  assert.strictEqual(await handler.getCurrentTemperature(), 25, 'the caught-up read applies');
});

// ---- local authoritative --------------------------------------------------

test('a cloud update is dropped while a recent local poll exists', async () => {
  const { handler } = makeHarness();
  handler.updateFromLocal(localStatus({ roomTemp: 24 }));
  // Cloud streaming/polling lags and reports a stale 30°C — must NOT clobber local.
  handler.updateFromZone(cloudZone({ roomTemp: 30 }));

  assert.strictEqual(await handler.getCurrentTemperature(), 24, 'local stays authoritative');
});

test('cloud updates still apply when no local data exists', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(cloudZone({ roomTemp: 30 }));
  assert.strictEqual(await handler.getCurrentTemperature(), 30, 'pure-cloud path unaffected');
});

// ---- sendDeviceCommand routing --------------------------------------------

test('commands prefer the local path when a unit is locally reachable', async () => {
  const local = makeLocalClient();
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22.3);

  assert.deepStrictEqual(local.calls.map((c) => c.commands), [{ spHeat: 22.3 }], 'sent locally');
  assert.strictEqual(sendCommandCalls.length, 0, 'cloud not used');
});

test('a failed local command falls back to the cloud', async () => {
  const local = makeLocalClient({ sendCommandResult: false });
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22.3);

  assert.strictEqual(local.calls.length, 1, 'local attempted first');
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: 22.3 }], 'then cloud');
});

test('commands skip local when the unit is not locally reachable', async () => {
  const local = makeLocalClient({ hasLocalResult: false });
  const { handler, sendCommandCalls } = makeHarness({ localClient: local });
  handler.updateFromLocal(localStatus({ operationMode: 'heat', spHeat: 20 }));

  await handler.setHeatingThresholdTemperature(22.3);

  assert.strictEqual(local.calls.length, 0, 'local not attempted');
  assert.deepStrictEqual(sendCommandCalls.map((c) => c.commands), [{ spHeat: 22.3 }], 'cloud used');
});

// ---- where an update came from (for the mirror's startup wait) ---------------

test('status listeners are told whether an update came from the LAN, the cloud or a command', async () => {
  const local = makeLocalClient();
  const { handler } = makeHarness({ localClient: local });
  const from = [];
  handler.onStatusUpdate((_s, source) => from.push(source));

  handler.updateFromZone(cloudZone({ operationMode: 'heat' }));
  handler.updateFromLocal(localStatus({ operationMode: 'cool' }), Date.now());
  await handler.setActive(Characteristic.Active.INACTIVE);
  await sleep(20);

  assert.deepStrictEqual(from, ['polling', 'local', 'command']);
});

// ---- asking the adapter to report to the cloud after a LAN command ----------
//
// The cloud never sees a LAN command, so the Comfort app kept showing the old
// state for minutes (2026-09-27: kitchen heating, Comfort app said off).

test('a LAN command asks the adapter to report to the cloud a moment later', async () => {
  const local = makeLocalClient();
  const { handler, kumoAPI } = makeHarness({ localClient: local });
  const asked = [];
  kumoAPI.requestDeviceStatus = (serial) => asked.push(serial);
  handler.CLOUD_SYNC_DELAY_MS = 5;
  handler.updateFromLocal(localStatus({ operationMode: 'off', power: 0 }));

  await handler.setActive(Characteristic.Active.ACTIVE);
  await sleep(40);

  assert.strictEqual(local.calls.length, 1, 'sent over the LAN');
  assert.deepStrictEqual(asked, [SERIAL], 'then one status request to the cloud');
});

test('a cloud command does not ask for a report (the cloud already knows)', async () => {
  const local = makeLocalClient({ hasLocalResult: false });
  const { handler, kumoAPI, sendCommandCalls } = makeHarness({ localClient: local });
  const asked = [];
  kumoAPI.requestDeviceStatus = (serial) => asked.push(serial);
  handler.CLOUD_SYNC_DELAY_MS = 5;
  handler.updateFromZone(cloudZone({ operationMode: 'off', power: 0 }));

  await handler.setActive(Characteristic.Active.ACTIVE);
  await sleep(40);

  assert.strictEqual(sendCommandCalls.length, 1, 'sent through the cloud');
  assert.deepStrictEqual(asked, []);
});

test('the log says when the cloud catches up with a LAN command', async () => {
  const local = makeLocalClient();
  const { handler, kumoAPI, platform } = makeHarness({ localClient: local });
  kumoAPI.requestDeviceStatus = () => {};
  handler.CLOUD_SYNC_DELAY_MS = 5;
  const infos = [];
  platform.log = { ...platform.log, info: (m) => infos.push(m) };
  handler.updateFromLocal(localStatus({ operationMode: 'cool' }));
  handler.updateFromLocal(localStatus({ operationMode: 'off', power: 0 }), Date.now() + 1);

  await handler.setActive(Characteristic.Active.ACTIVE);   // restores cool
  await sleep(20);
  assert.strictEqual(local.calls[0].commands.operationMode, 'cool');
  handler.updateFromZone(cloudZone({ operationMode: 'off', power: 0 }));   // not yet
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1 }));  // caught up

  const synced = infos.filter((m) => m.includes('[CLOUD SYNC]'));
  assert.strictEqual(synced.length, 1, synced.join(' | '));
  assert.match(synced[0], /the cloud now reports cool/);
});
