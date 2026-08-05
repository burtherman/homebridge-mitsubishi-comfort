'use strict';

// Mirroring across a restart.
//
// The first source observation after a restart seeds the baseline without pushing,
// so a reboot doesn't clobber a manually-adjusted target. That rule used to also
// swallow a source change that happened while the plugin was DOWN — a real edge we
// weren't running to see. Given the persisted signature the controller can tell the
// two apart. Regression cover for the 2026-08-05 outage: Homebridge crash-looped for
// 41 minutes, the kitchen was switched on at the wall meanwhile, and the living room
// stayed off afterwards with nothing left to re-sync it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MirrorController, signature } = require('../dist/mirror.js');
const { loadMirrorStore, saveMirrorStore } = require('../dist/mirror-store.js');

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

// A persistence double backed by a plain object, so a "restart" is just a new
// controller over the same map.
function makePersist(seed = {}) {
  const store = new Map(Object.entries(seed));
  const saves = [];
  return {
    load: (serial) => store.get(serial) ?? null,
    save: (serial, sig) => { store.set(serial, sig); saves.push([serial, sig]); },
    _store: store,
    saves,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = (over = {}) => ({ operationMode: 'heat', power: 1, spHeat: 21, spCool: 24, fanSpeed: 'auto', ...over });

// ---- the outage case ------------------------------------------------------

test('source changed while the plugin was down → first observation re-syncs the target', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  // Persisted at shutdown: off. Comes back cooling — that happened while we were down.
  const persist = makePersist({ SRC: 'off' });
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15, persist);

  src._fire(st({ operationMode: 'cool', spCool: 24.5 }));
  await sleep(45);

  assert.strictEqual(tgt.applyCalls.length, 1);
  assert.strictEqual(tgt.applyCalls[0].operationMode, 'cool');
  assert.strictEqual(tgt.applyCalls[0].spCool, 24.5);
});

test('source unchanged across the restart → still seeds silently, manual target survives', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  const persist = makePersist({ SRC: signature(st({ spHeat: 21 })) });
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15, persist);

  src._fire(st({ spHeat: 21 }));
  await sleep(45);

  assert.strictEqual(tgt.applyCalls.length, 0);
});

test('no persisted signature (first ever run) → seeds without pushing', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  const persist = makePersist();
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15, persist);

  src._fire(st({ spHeat: 21 }));
  await sleep(45);

  assert.strictEqual(tgt.applyCalls.length, 0);
  assert.strictEqual(persist.load('SRC'), signature(st({ spHeat: 21 })));
});

test('no persistence adapter at all → unchanged legacy behavior', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15);

  src._fire(st({ operationMode: 'cool', spCool: 24.5 }));
  await sleep(45);

  assert.strictEqual(tgt.applyCalls.length, 0);
});

test('a mid-run change persists its new signature', async () => {
  const src = makeHandler('SRC'); const tgt = makeHandler('TGT');
  const persist = makePersist();
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [src, tgt], 15, persist);

  src._fire(st({ spHeat: 21 }));            // seed
  await sleep(45);
  src._fire(st({ spHeat: 22 }));            // change
  await sleep(45);

  assert.strictEqual(tgt.applyCalls.length, 1);
  assert.strictEqual(persist.load('SRC'), signature(st({ spHeat: 22 })));
});

test('the re-sync survives a second restart without re-firing', async () => {
  const persist = makePersist({ SRC: 'off' });

  // Restart 1: source came back cooling → re-sync.
  const s1 = makeHandler('SRC'); const t1 = makeHandler('TGT');
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [s1, t1], 15, persist);
  s1._fire(st({ operationMode: 'cool', spCool: 24.5 }));
  await sleep(45);
  assert.strictEqual(t1.applyCalls.length, 1);

  // Restart 2: nothing changed since → silent, no second clobber.
  const s2 = makeHandler('SRC'); const t2 = makeHandler('TGT');
  new MirrorController(makeLog(), [{ source: 'SRC', target: 'TGT' }], [s2, t2], 15, persist);
  s2._fire(st({ operationMode: 'cool', spCool: 24.5 }));
  await sleep(45);
  assert.strictEqual(t2.applyCalls.length, 0);
});

// ---- the on-disk store ----------------------------------------------------

test('mirror store round-trips through disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-store-'));
  const file = path.join(dir, 'state.json');
  const sigs = new Map([['SRC', 'cool|24.5|auto'], ['SRC2', 'off']]);

  saveMirrorStore(file, sigs, makeLog());
  const back = loadMirrorStore(file, makeLog());

  assert.strictEqual(back.get('SRC'), 'cool|24.5|auto');
  assert.strictEqual(back.get('SRC2'), 'off');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing store loads empty rather than throwing', () => {
  const back = loadMirrorStore('/nonexistent/definitely/not/here.json', makeLog());
  assert.strictEqual(back.size, 0);
});

test('a corrupt store degrades to empty instead of blocking startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-store-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ this is not json');

  const back = loadMirrorStore(file, makeLog());

  assert.strictEqual(back.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save leaves no stray temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-store-'));
  const file = path.join(dir, 'state.json');

  saveMirrorStore(file, new Map([['SRC', 'off']]), makeLog());

  assert.deepStrictEqual(fs.readdirSync(dir), ['state.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
