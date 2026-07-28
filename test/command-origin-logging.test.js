'use strict';

// Command origin + observed-state attribution logging.
//
// Motivating failure (2026-07-28): a Living room unit with NO wall control — it can
// only be driven by the Kumo app or Homebridge — went cool -> off some time between
// 13:08 and 19:30. The log recorded every command the plugin SENT ([MODE CHANGE],
// [MIRROR]) and none of them fired, yet the unit was off. Nothing recorded a change
// arriving from outside Homebridge, so "what turned it off?" was unanswerable.
//
// Two additions close that:
//   [CMD]   — every command we send, tagged with where it came from
//   [STATE] — every observed power/mode transition, attributed to us or flagged
//             EXTERNAL
//
// The precision that matters: a stale cloud replay must NOT be reported as EXTERNAL.
// This plugin already has a documented ~7-10s cloud lag that replays pre-command
// state (see mirror-stale-revive.test.js), and a logger that cries wolf on every
// one of those is worse than no logger at all.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');

const SERIAL = 'TESTORIGIN01';

function makeLog() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { lines, info: push, warn: push, error: push, debug: () => {} };
}

const charCache = {};
const Characteristic = new Proxy({}, {
  get(_t, prop) {
    if (!charCache[prop]) { charCache[prop] = { _name: String(prop), OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 }; }
    return charCache[prop];
  },
});
const Service = { AccessoryInformation: 'AccessoryInformation', Thermostat: 'Thermostat', Switch: 'Switch', FilterMaintenance: 'FilterMaintenance' };

function makeCharacteristic() { const ch = { value: undefined, onGet() { return ch; }, onSet() { return ch; }, setProps() { return ch; } }; return ch; }
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
    displayName: 'Living room',
    context: { device: { deviceSerial: SERIAL, siteId: 'site-1', displayName: 'Living room' } },
    getService(type) { const e = entries.find((x) => x.type === type && x.subtype === undefined); return e ? e.svc : null; },
    getServiceById(type, subtype) { const e = entries.find((x) => x.type === type && x.subtype === subtype); return e ? e.svc : null; },
    addService(type, name, subtype) { const svc = makeService(type, name, subtype); entries.push({ type, subtype, svc }); return svc; },
    removeService(svc) { const i = entries.findIndex((x) => x.svc === svc); if (i >= 0) entries.splice(i, 1); },
  };
}
function makeHarness() {
  const log = makeLog();
  const platform = { Service, Characteristic, log, api: { updatePlatformAccessories() {} }, localClient: null };
  const kumoAPI = { subscribeToDevice() {}, onDeviceProfileUpdate() {}, sendCommand() { return Promise.resolve(true); } };
  const handler = new KumoThermostatAccessory(platform, makeAccessory(), kumoAPI, 30);
  return { handler, log };
}

const cloudZone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'auto', airDirection: 'auto',
    roomTemp: 24, spCool: 24, spHeat: 20, spAuto: null, humidity: null, ...over,
  },
});

const stateLines = (log) => log.lines.filter((l) => l.startsWith('[STATE]'));

// ---- the motivating case -------------------------------------------------

test('a change made outside Homebridge is logged as EXTERNAL', () => {
  const { handler, log } = makeHarness();
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1 }));

  // Nobody commanded anything — the unit simply reports off, which is exactly what
  // the Living room did on 2026-07-28 with no command on any logged path.
  handler.updateFromZone(cloudZone({ operationMode: 'off', power: 0 }));

  const lines = stateLines(log);
  assert.strictEqual(lines.length, 1, `expected one [STATE] line, got: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /cool -> off/);
  assert.match(lines[0], /EXTERNAL/);
});

test('no [STATE] line when the power/mode label is unchanged', () => {
  const { handler, log } = makeHarness();
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1, roomTemp: 24 }));
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1, roomTemp: 26 }));
  assert.deepStrictEqual(stateLines(log), [], 'a temperature drift is not a state change');
});

test('power=0 reads as off even when operationMode still says cool', () => {
  const { handler, log } = makeHarness();
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1 }));
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 0 }));
  assert.match(stateLines(log)[0], /cool -> off/);
});

// ---- precision: do not cry wolf -----------------------------------------

test('a stale cloud replay after our own command is UNEXPECTED, never EXTERNAL', async () => {
  const { handler, log } = makeHarness();
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1 }));

  // HomeKit turns it off; the optimistic update moves cached state to off.
  await handler.setTargetHeatingCoolingState(Characteristic.TargetHeatingCoolingState.OFF);

  // The cloud lags ~7-10s and replays the pre-command "cool".
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1 }));

  const lines = stateLines(log);
  assert.strictEqual(lines.length, 1, `expected one [STATE] line, got: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /off -> cool/);
  assert.match(lines[0], /UNEXPECTED/);
  assert.ok(!/EXTERNAL/.test(lines[0]), `a stale replay must not be blamed on a person: ${lines[0]}`);
});

// ---- [CMD] origin tagging ------------------------------------------------

test('every command logs its origin', async () => {
  const { handler, log } = makeHarness();
  handler.updateFromZone(cloudZone({ operationMode: 'cool', power: 1 }));

  await handler.setTargetHeatingCoolingState(Characteristic.TargetHeatingCoolingState.OFF);
  const cmd = log.lines.filter((l) => l.startsWith('[CMD]'));
  assert.strictEqual(cmd.length, 1, `expected one [CMD] line, got: ${JSON.stringify(cmd)}`);
  assert.match(cmd[0], /Living room <- homekit:mode/);
  assert.match(cmd[0], /via cloud/);
  assert.match(cmd[0], /"operationMode":"off"/);
});

test('a mirror-driven command is tagged mirror, not homekit', async () => {
  const { handler, log } = makeHarness();
  handler.updateFromZone(cloudZone({ operationMode: 'off', power: 0 }));

  await handler.applyMirror({ operationMode: 'cool', spCool: 23.5, spHeat: 20, fanSpeed: 'auto' });

  const cmd = log.lines.filter((l) => l.startsWith('[CMD]'));
  assert.ok(cmd.length >= 1, `expected a [CMD] line, got: ${JSON.stringify(log.lines)}`);
  assert.match(cmd[0], /<- mirror/);
  assert.ok(!/homekit/.test(cmd[0]), `mirror command mislabelled: ${cmd[0]}`);
});
