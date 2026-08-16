'use strict';

// Unit tests for local humidity reads (src/local-api.ts:getHumidity).
//
// The main status read has no humidity, so it comes from a separate query: an
// external wireless sensor (sensors slots 0-3, first with humidity wins) or an MHK2
// wall control (indoorHumid) as fallback. The source is discovered once and cached
// so steady-state polling costs one request (has a source) or zero (has neither).
// We stub `request` to assert the discovery, caching, and re-discovery behavior
// without touching the network.

const test = require('node:test');
const assert = require('node:assert');
const { LocalKumoClient } = require('../dist/local-api.js');

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };

function makeClient(responder) {
  const client = new LocalKumoClient(NOOP_LOG, 6000, false);
  const calls = [];
  client.request = async (_serial, body) => {
    const s = body.toString();
    calls.push(s);
    return responder(s);
  };
  return { client, calls };
}

test('external sensor humidity: returns value + battery/rssi and caches the slot', async () => {
  const { client, calls } = makeClient((body) => {
    if (body.includes('"sensors":{"0"')) {
      return { sensors: { '0': { uuid: 'abc', humidity: 55.5, battery: 90, rssi: -72 } } };
    }
    return null;
  });
  const h = await client.getHumidity('S');
  assert.deepStrictEqual(h, { humidity: 55.5, battery: 90, rssi: -72 });

  const n = calls.length;
  await client.getHumidity('S'); // cached → only re-reads slot 0, never MHK2
  assert.ok(!calls.slice(n).some(b => b.includes('mhk2')), 'cached sensor must not query MHK2');
  assert.strictEqual(calls.slice(n).length, 1, 'cached sensor costs exactly one request');
});

test('MHK2 fallback when no sensor reports humidity', async () => {
  const { client } = makeClient((body) => {
    if (body.includes('"sensors":{"0"')) return { sensors: { '0': { uuid: null } } };
    if (body.includes('mhk2')) return { mhk2: { status: { indoorHumid: 48 } } };
    return null;
  });
  const h = await client.getHumidity('S');
  assert.deepStrictEqual(h, { humidity: 48 });
});

test('no source: returns null and latches so later polls make zero requests', async () => {
  const { client, calls } = makeClient((body) => {
    if (body.includes('"sensors":{"0"')) return { sensors: { '0': { uuid: null } } };
    if (body.includes('mhk2')) return { mhk2: null };
    return null;
  });
  assert.strictEqual(await client.getHumidity('S'), null);
  const n = calls.length;
  assert.strictEqual(await client.getHumidity('S'), null);
  assert.strictEqual(calls.length, n, 'a latched "none" must make no further requests');
});

test('sensor discovery skips a uuid-only slot and takes the next slot with humidity', async () => {
  const { client } = makeClient((body) => {
    if (body.includes('"sensors":{"0"')) return { sensors: { '0': { uuid: 'x' } } }; // paired, no humidity
    if (body.includes('"sensors":{"1"')) return { sensors: { '1': { uuid: 'y', humidity: 51 } } };
    return null;
  });
  const h = await client.getHumidity('S');
  assert.strictEqual(h.humidity, 51);
});

test('a cached sensor that stops answering is re-discovered', async () => {
  let hum = 55;
  const { client } = makeClient((body) => {
    if (body.includes('"sensors":{"0"')) {
      return { sensors: { '0': hum === null ? { uuid: null } : { uuid: 'x', humidity: hum } } };
    }
    if (body.includes('mhk2')) return { mhk2: null };
    return null;
  });
  assert.strictEqual((await client.getHumidity('S')).humidity, 55); // caches sensor slot 0
  hum = null;
  assert.strictEqual(await client.getHumidity('S'), null);           // source gone → drop cache
  hum = 60;
  assert.strictEqual((await client.getHumidity('S')).humidity, 60);  // re-discovered
});
