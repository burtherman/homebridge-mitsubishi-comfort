'use strict';

// A unit marked offline must come back when the cloud says it's connected again.
//
// Found live 2026-09-28: the cloud reported the front bedroom offline at 20:42 and
// 21:09 ("IoT Disconnected"). Its status record shows it reported to the cloud again
// at 21:14, and the Comfort app showed it, but no device_status_v2 "connected" push
// ever arrived, so the plugin kept it at No Response for over an hour. While a unit is
// marked offline the plugin now re-asks for its status every minute.

const test = require('node:test');
const assert = require('node:assert');
const { KumoAPI } = require('../dist/kumo-api.js');

const SERIAL = '0Y34P008Q100142F';

function makeApi() {
  const logs = { warn: [], info: [] };
  const log = {
    info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error() {}, debug() {},
  };
  const api = new KumoAPI('user@example.com', 'pw', log, false, true);
  const emits = [];
  api.socket = { emit: (...args) => emits.push(args) };
  const changes = [];
  api.onDeviceConnectionStatusChange((serial, connected) => changes.push([serial, connected]));
  return { api, emits, changes, logs };
}

test('an offline unit is re-asked about, and comes back when the cloud says connected', () => {
  const { api, emits, changes, logs } = makeApi();
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected', lastDisconnectedReason: 'IoT Disconnected' });
  assert.deepStrictEqual(changes, [[SERIAL, false]]);

  api.recheckOfflineDevices();
  assert.deepStrictEqual(emits, [['device_status_v2', SERIAL]], 'asks about the offline unit');

  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'connected' });
  assert.deepStrictEqual(changes, [[SERIAL, false], [SERIAL, true]], 'reachable again');
  assert.ok(logs.info.some((m) => m.includes('reported online again')));

  api.lastOfflineRecheck = 0;
  api.recheckOfflineDevices();
  assert.strictEqual(emits.length, 1, 'nothing to re-ask once every unit is connected');
});

test('re-asking is limited to once a minute', () => {
  const { api, emits } = makeApi();
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected' });
  api.recheckOfflineDevices();
  api.recheckOfflineDevices();                  // the 30s health tick, too soon
  assert.strictEqual(emits.length, 1);
  api.lastOfflineRecheck = Date.now() - 61000;  // a minute later
  api.recheckOfflineDevices();
  assert.strictEqual(emits.length, 2);
});

test('the offline warning is logged once, not on every answer while it stays offline', () => {
  const { api, logs, changes } = makeApi();
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected' });
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected' });
  api.handleDeviceStatus({ deviceSerial: SERIAL, status: 'disconnected' });
  assert.strictEqual(logs.warn.filter((m) => m.includes('reported offline')).length, 1);
  assert.strictEqual(changes.length, 1, 'one change, one callback');
});
