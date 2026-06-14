'use strict';

// Unit tests for the local LAN transport core (src/local-api.ts).
//
// The token algorithm is a port of pykumo's `_token()`, already live-verified
// against real hardware (a signed status read returned 200 + r.indoorUnit.status).
// These tests guard the PORT against regressions — determinism, shape, and
// sensitivity to inputs — plus the pure command/status mapping logic.

const test = require('node:test');
const assert = require('node:assert');
const {
  computeLocalToken,
  buildLocalCommandBody,
  mapLocalStatus,
  STATUS_READ_BODY,
} = require('../dist/local-api.js');

// 10-byte hex cryptoSerial (>= 9 bytes) + base64 password.
const CS = '0123456789abcdef0123';
const PW = Buffer.from('local-secret').toString('base64');

// ---- computeLocalToken ----------------------------------------------------

test('token is a deterministic 64-char hex string', () => {
  const a = computeLocalToken(PW, CS, STATUS_READ_BODY);
  const b = computeLocalToken(PW, CS, STATUS_READ_BODY);
  assert.strictEqual(a, b, 'same inputs -> same token');
  assert.match(a, /^[0-9a-f]{64}$/, 'sha-256 hex digest');
});

test('token changes with the request body', () => {
  const read = computeLocalToken(PW, CS, STATUS_READ_BODY);
  const write = computeLocalToken(PW, CS, buildLocalCommandBody({ spCool: 23 }));
  assert.notStrictEqual(read, write);
});

test('token changes with the credentials', () => {
  const t1 = computeLocalToken(PW, CS, STATUS_READ_BODY);
  const t2 = computeLocalToken(PW, 'fedcba98765432100123', STATUS_READ_BODY);
  const t3 = computeLocalToken(Buffer.from('other').toString('base64'), CS, STATUS_READ_BODY);
  assert.notStrictEqual(t1, t2, 'cryptoSerial affects the token');
  assert.notStrictEqual(t1, t3, 'password affects the token');
});

test('token rejects a too-short cryptoSerial (< 9 bytes)', () => {
  assert.throws(() => computeLocalToken(PW, '0123456789abcdef', STATUS_READ_BODY), /too short/);
});

// ---- buildLocalCommandBody ------------------------------------------------

const parseBody = (buf) => JSON.parse(buf.toString('utf8'));
const innerStatus = (cmds) => parseBody(buildLocalCommandBody(cmds)).c.indoorUnit.status;

test('operationMode maps to the local `mode` field', () => {
  assert.deepStrictEqual(innerStatus({ operationMode: 'cool' }), { mode: 'cool' });
  assert.deepStrictEqual(innerStatus({ operationMode: 'auto' }), { mode: 'auto' });
});

test('power is dropped — on/off is expressed by mode only', () => {
  // The cloud fan/dry/off paths send an explicit power; locally there is no
  // power field, so it must never appear in the body.
  assert.deepStrictEqual(innerStatus({ operationMode: 'off', power: 0 }), { mode: 'off' });
  assert.deepStrictEqual(innerStatus({ operationMode: 'vent', power: 1 }), { mode: 'vent' });
});

test('setpoints are sent under spHeat/spCool, rounded to 0.1°C', () => {
  assert.deepStrictEqual(innerStatus({ spCool: 23.34 }), { spCool: 23.3 });
  assert.deepStrictEqual(innerStatus({ spHeat: 21.06 }), { spHeat: 21.1 });
  assert.deepStrictEqual(innerStatus({ spHeat: 20, spCool: 24 }), { spHeat: 20, spCool: 24 });
});

test('the command envelope is {"c":{"indoorUnit":{"status":{...}}}}', () => {
  const body = parseBody(buildLocalCommandBody({ spCool: 23 }));
  assert.deepStrictEqual(Object.keys(body), ['c']);
  assert.deepStrictEqual(Object.keys(body.c), ['indoorUnit']);
  assert.deepStrictEqual(Object.keys(body.c.indoorUnit), ['status']);
});

// ---- mapLocalStatus -------------------------------------------------------

test('local status maps onto DeviceStatus (mode->operationMode, vaneDir->airDirection)', () => {
  const mapped = mapLocalStatus({
    mode: 'cool', roomTemp: 27, spCool: 24.5, spHeat: 22.5,
    vaneDir: 'swing', fanSpeed: 'auto', filterDirty: true, defrost: false, standby: false,
  });
  assert.strictEqual(mapped.operationMode, 'cool');
  assert.strictEqual(mapped.power, 1, 'a non-off mode is powered on');
  assert.strictEqual(mapped.roomTemp, 27);
  assert.strictEqual(mapped.spCool, 24.5);
  assert.strictEqual(mapped.spHeat, 22.5);
  assert.strictEqual(mapped.airDirection, 'swing', 'vaneDir maps to airDirection');
  assert.strictEqual(mapped.filterDirty, true);
  assert.strictEqual(mapped.spAuto, null, 'these units have no spAuto');
  assert.strictEqual(mapped.connected, true, 'a successful read means reachable');
});

test('mode "off" maps to power 0', () => {
  const mapped = mapLocalStatus({ mode: 'off', roomTemp: 22, spCool: 24, spHeat: 20 });
  assert.strictEqual(mapped.power, 0);
  assert.strictEqual(mapped.operationMode, 'off');
});

test('boolean status flags default to false when absent', () => {
  const mapped = mapLocalStatus({ mode: 'heat', roomTemp: 21, spHeat: 21, spCool: 24 });
  assert.strictEqual(mapped.filterDirty, false);
  assert.strictEqual(mapped.defrost, false);
  assert.strictEqual(mapped.standby, false);
});
