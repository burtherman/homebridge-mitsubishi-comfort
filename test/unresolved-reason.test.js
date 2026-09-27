'use strict';

// Why a unit stayed on cloud control (platform.ts reportUnresolved), and the legacy
// v2 fetch outcome log (kumo-api.ts describeLegacyFetch / noteLegacyOutcome).
//
// Motivation (issue #29, 2026-09-11): a user saw "on the LAN but its credential
// didn't authenticate" for all six units. That message came from ARP evidence
// alone. The sweep can't tell a rejected credential from a probe that timed out,
// so a slow adapter with a GOOD credential produced the same line. Separately, the
// v2 fetch's HTTP status was logged at debug, so an account v2 answers with 500
// (no pre-Comfort-app record) got no explanation at all.

const test = require('node:test');
const assert = require('node:assert');
const { KumoV3Platform } = require('../dist/platform.js');
const { KumoAPI, describeLegacyFetch } = require('../dist/kumo-api.js');

const A = 'SERIAL-A';
const MAC = 'AA:BB:CC:DD:EE:01';
const IP = '192.168.1.50';
const CREDS = { password: 'pw', cryptoSerial: 'cs' };

function makeLog() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const log = {};
  for (const level of Object.keys(lines)) {
    log[level] = (msg) => lines[level].push(msg);
  }
  return { log, lines };
}

function makeApi() {
  return {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => `uuid-${s}` } },
    platformAccessory: function PlatformAccessory() {},
    on: () => {},
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };
}

function makePlatform(probeResult, { inArp = true } = {}) {
  const { log, lines } = makeLog();
  const platform = new KumoV3Platform(log, {
    name: 'test',
    platform: 'KumoV3',
    username: 'user@example.com',
    password: 'secret',
    disablePolling: true,
    localControl: true,
  }, makeApi());
  const admitted = new Map();
  platform.localClient = { setCreds: (serial, c) => admitted.set(serial, c), hasLocal: (s) => admitted.has(s) };
  platform.deviceMacs.set(A, MAC);
  platform.readArpTable = () => (inArp ? new Map([[MAC.toLowerCase(), IP]]) : new Map());
  const probes = [];
  platform.probeLocal = async (ip, creds) => {
    probes.push({ ip, creds });
    return probeResult;
  };
  return { platform, lines, admitted, probes };
}

test('a rejected credential at the unit\'s own address is reported as rejected', async () => {
  const { platform, lines, probes, admitted } = makePlatform('kumo');
  const pending = new Map([[A, CREDS]]);
  await platform.reportUnresolved(pending);
  assert.deepStrictEqual(probes, [{ ip: IP, creds: CREDS }]);
  assert.strictEqual(lines.warn.length, 1);
  assert.match(lines.warn[0], /on the LAN at 192\.168\.1\.50 but rejected its local credential/);
  assert.strictEqual(admitted.size, 0);
});

test('no answer at the unit\'s address is not blamed on the credential', async () => {
  const { platform, lines } = makePlatform(null);
  await platform.reportUnresolved(new Map([[A, CREDS]]));
  assert.strictEqual(lines.warn.length, 1);
  assert.match(lines.warn[0], /didn't answer the local probe/);
  assert.doesNotMatch(lines.warn[0], /credential/);
});

test('a unit that answers the re-probe was only slow: admitted, not reported', async () => {
  const { platform, lines, admitted } = makePlatform('match');
  const pending = new Map([[A, CREDS]]);
  await platform.reportUnresolved(pending);
  assert.strictEqual(lines.warn.length, 0);
  assert.deepStrictEqual(admitted.get(A), { ...CREDS, ip: IP });
  assert.strictEqual(pending.size, 0);
  assert.ok(lines.info.some(l => /Discovered SERIAL-A at 192\.168\.1\.50/.test(l)));
});

test('a unit with no ARP entry is not probed and keeps the generic message', async () => {
  const { platform, lines, probes } = makePlatform('kumo', { inArp: false });
  await platform.reportUnresolved(new Map([[A, CREDS]]));
  assert.strictEqual(probes.length, 0);
  assert.strictEqual(lines.warn.length, 1);
  assert.match(lines.warn[0], /could not be reached or authenticated locally/);
});

test('no unresolved-unit message suggests re-pairing in the app', async () => {
  for (const result of ['kumo', null]) {
    const { platform, lines } = makePlatform(result);
    await platform.reportUnresolved(new Map([[A, CREDS]]));
    for (const line of lines.warn) {
      assert.doesNotMatch(line, /re-pair/i);
    }
  }
});

test('describeLegacyFetch: HTTP 500 explains the missing pre-Comfort record, at info', () => {
  const d = describeLegacyFetch({ kind: 'http', status: 500 });
  assert.strictEqual(d.level, 'info');
  assert.match(d.message, /HTTP 500/);
  assert.match(d.message, /no record from before the Comfort app/);
});

test('describeLegacyFetch: other failures and an empty result are info; a normal fetch is debug', () => {
  assert.strictEqual(describeLegacyFetch({ kind: 'http', status: 503 }).level, 'info');
  assert.strictEqual(describeLegacyFetch({ kind: 'error', message: 'aborted' }).level, 'info');
  const empty = describeLegacyFetch({ kind: 'ok', count: 0 });
  assert.strictEqual(empty.level, 'info');
  assert.match(empty.message, /no device credentials/);
  assert.strictEqual(describeLegacyFetch({ kind: 'ok', count: 5 }).level, 'debug');
});

test('noteLegacyOutcome logs once per change, not on every minute-cadence retry', () => {
  const { log, lines } = makeLog();
  const api = new KumoAPI('user@example.com', 'pw', log, false, false);
  for (let i = 0; i < 5; i++) {
    api.noteLegacyOutcome({ kind: 'http', status: 500 });
  }
  assert.strictEqual(lines.info.length, 1, 'a repeated 500 must log once');
  api.noteLegacyOutcome({ kind: 'error', message: 'socket hang up' });
  assert.strictEqual(lines.info.length, 2, 'a different outcome logs again');
  api.noteLegacyOutcome({ kind: 'error', message: 'different text, same kind' });
  assert.strictEqual(lines.info.length, 2, 'error text alone is not a new outcome');
});
