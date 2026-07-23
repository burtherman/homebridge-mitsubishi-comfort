'use strict';

// MirrorController: edge-triggered, mode-aware, debounced dispatch to targets.
// Tested with fake handler doubles so the controller's logic is exercised in
// isolation from the accessory.

const test = require('node:test');
const assert = require('node:assert');
const { MirrorController, signature, toMirrorState } = require('../dist/mirror.js');

function makeLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function makeHandler(serial) {
  let listener = null;
  const applyCalls = [];
  return {
    getDeviceSerial: () => serial,
    onStatusUpdate: (l) => { listener = l; },
    applyMirror: async (desired) => { applyCalls.push(desired); },
    _fire: (status) => { if (listener) listener(status); },
    applyCalls,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = (over = {}) => ({ operationMode: 'heat', power: 1, spHeat: 21, spCool: 24, fanSpeed: 'auto', ...over });

// ---- signature (pure) -----------------------------------------------------

test('signature is mode-aware: an inactive-setpoint change is ignored', () => {
  // In heat, spCool is not shown/used — a drift there must not re-sync.
  assert.strictEqual(signature(st({ operationMode: 'heat' })), signature(st({ operationMode: 'heat', spCool: 26 })));
});

test('signature changes when the active setpoint changes', () => {
  assert.notStrictEqual(signature(st({ operationMode: 'heat', spHeat: 21 })), signature(st({ operationMode: 'heat', spHeat: 22 })));
});

test('signature: off collapses regardless of setpoints', () => {
  const a = signature(st({ operationMode: 'off', power: 0, spHeat: 21, spCool: 24 }));
  const b = signature(st({ operationMode: 'off', power: 0, spHeat: 30, spCool: 10, fanSpeed: 'high' }));
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'off');
});

test('signature: autoHeat and autoCool normalize to the same auto signature', () => {
  assert.strictEqual(signature(st({ operationMode: 'autoHeat' })), signature(st({ operationMode: 'autoCool' })));
});

test('signature: a fan-speed change triggers (fan is mirrored)', () => {
  assert.notStrictEqual(signature(st({ fanSpeed: 'auto' })), signature(st({ fanSpeed: 'powerful' })));
});

// ---- controller behavior --------------------------------------------------

test('baseline seed: the first source observation does not push', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15);
  src._fire(st({ spHeat: 21 }));
  await sleep(45);
  assert.strictEqual(tgt.applyCalls.length, 0);
});

test('a source change pushes once (debounced) with the changed value', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15);
  src._fire(st({ spHeat: 21 }));            // seed
  await sleep(45);
  src._fire(st({ spHeat: 22 }));            // change
  await sleep(45);
  assert.strictEqual(tgt.applyCalls.length, 1);
  assert.strictEqual(tgt.applyCalls[0].spHeat, 22);
});

test('an unchanged repeat does not push (a manual target change survives)', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15);
  src._fire(st({ spHeat: 21 }));            // seed
  await sleep(45);
  src._fire(st({ spHeat: 21 }));            // same signature
  await sleep(45);
  assert.strictEqual(tgt.applyCalls.length, 0);
});

test('debounce coalesces a burst into one push of the settled state', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 30);
  src._fire(st({ spHeat: 21 }));            // seed
  await sleep(60);
  src._fire(st({ spHeat: 22 }));           // drag 21→22→23 within one window
  src._fire(st({ spHeat: 23 }));
  await sleep(60);
  assert.strictEqual(tgt.applyCalls.length, 1);
  assert.strictEqual(tgt.applyCalls[0].spHeat, 23);
});

test('full re-sync: a temp-only source change pushes the full mode+setpoint state', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15);
  src._fire(st({ operationMode: 'heat', spHeat: 21 }));   // seed
  await sleep(45);
  src._fire(st({ operationMode: 'heat', spHeat: 22 }));   // temp-only change
  await sleep(45);
  assert.deepStrictEqual(tgt.applyCalls[0], {
    operationMode: 'heat', power: 1, spHeat: 22, spCool: 24, fanSpeed: 'auto',
  });
});

test('one source can drive multiple targets', async () => {
  const src = makeHandler('SRC'); const t1 = makeHandler('T1'); const t2 = makeHandler('T2');
  new MirrorController(makeLog(), [
    { source: 'SRC', target: 'T1' },
    { source: 'SRC', target: 'T2' },
  ], [src, t1, t2], 15);
  src._fire(st({ spHeat: 21 }));           // seed
  await sleep(45);
  src._fire(st({ spHeat: 22 }));           // change
  await sleep(45);
  assert.strictEqual(t1.applyCalls.length, 1);
  assert.strictEqual(t2.applyCalls.length, 1);
});

test('unknown / self-referential pairs are skipped without throwing', () => {
  const src = makeHandler('SRC');
  assert.doesNotThrow(() => new MirrorController(makeLog(), [
    { source: 'SRC', target: 'NOPE' },
    { source: 'GONE', target: 'SRC' },
    { source: 'SRC', target: 'SRC' },
  ], [src], 15));
});

test('toMirrorState projects a full DeviceStatus down to the mirrored fields', () => {
  const full = {
    id: 'z', deviceSerial: 'SRC', rssi: -50, power: 1, operationMode: 'cool',
    humidity: 40, fanSpeed: 'quiet', airDirection: 'auto', roomTemp: 22,
    spCool: 23, spHeat: 20, spAuto: null, modelNumber: 'X', connected: true,
  };
  assert.deepStrictEqual(toMirrorState(full), {
    operationMode: 'cool', power: 1, spHeat: 20, spCool: 23, fanSpeed: 'quiet',
  });
});
