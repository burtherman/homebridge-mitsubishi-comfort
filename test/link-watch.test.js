'use strict';

// TEMPORARY diagnostic (2.0 soak), see src/link-watch.ts. On 2026-10-11 the front
// bedroom (cloud-only) sat cut off for most of a day while the cloud called it
// connected, and with no HomeKit command sent the plugin never noticed. The link
// watch records, every few minutes, what each cloud-only unit's link is doing, so the
// next dropout shows which signal to build a real check on. It never touches HomeKit.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LinkWatch, LINK_WATCH_MISS_NOTE, LINK_WATCH_MAX_BYTES } = require('../dist/link-watch.js');

const SERIAL = '0Y34P008Q100142F';
const MIN = 60000;

function makeWatch({ file = null } = {}) {
  const env = {
    now: 1_800_000_000_000,
    unit: { serial: SERIAL, name: 'Front bedroom', cloudOnly: true, lastCloudUpdateAt: 0, roomTemp: 22.5, mode: 'off', reachable: true },
    others: [],
    asked: [],
    streamDown: false,
    lan: { answer: 'answers', ip: '192.168.50.142' },
    reportedAt: 1_799_999_000_000,
    logs: { info: [], warn: [] },
    lines: [],
  };
  const watch = new LinkWatch({
    targets: () => [env.unit, ...env.others],
    requestStatus: (serial) => env.asked.push(serial),
    streamInterruptedSince: () => env.streamDown,
    lanProbe: async () => env.lan,
    adapterReportedAt: async () => env.reportedAt,
    log: { info: (m) => env.logs.info.push(m), warn: (m) => env.logs.warn.push(m), debug() {} },
    file,
    now: () => env.now,
  });
  // One sample, then 5 minutes pass. `answered` = a device_update came back in between.
  env.step = async ({ answered = false } = {}) => {
    await watch.tick();
    if (answered) {
      env.unit.lastCloudUpdateAt = env.now + 2000;
    }
    env.now += 5 * MIN;
  };
  return { watch, env };
}

const readLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'link-watch-')), 'watch.log');

test('each sample asks for status and records whether the last request was answered', async () => {
  const file = tmpFile();
  const { env } = makeWatch({ file });
  await env.step({ answered: true });
  await env.step({ answered: false });
  await env.step({ answered: true });
  await env.step();

  assert.deepStrictEqual(env.asked, [SERIAL, SERIAL, SERIAL, SERIAL]);
  const lines = readLines(file);
  assert.strictEqual(lines.length, 4);
  assert.match(lines[0], /Front bedroom request=first misses=0 temp=22\.5 .*mode=off lan=answers@192\.168\.50\.142 .*homekit=ok/);
  assert.match(lines[1], /request=answered misses=0/);
  assert.match(lines[2], /request=unanswered misses=1/);
  assert.match(lines[3], /request=answered misses=0/);
});

test('units on the LAN are not watched', async () => {
  const { env } = makeWatch();
  env.unit.cloudOnly = false;
  await env.step();
  await env.step();
  assert.deepStrictEqual(env.asked, []);
});

test('a request that went out during a stream drop is not a miss', async () => {
  const file = tmpFile();
  const { env } = makeWatch({ file });
  await env.step();
  env.streamDown = true;
  await env.step();
  assert.match(readLines(file)[1], /request=stream-down misses=0/);
});

test('a long run of unanswered requests is noted once in the Homebridge log, and so is its end', async () => {
  const { env } = makeWatch();
  await env.step();
  for (let i = 0; i < LINK_WATCH_MISS_NOTE + 2; i += 1) {
    await env.step();
  }
  assert.strictEqual(env.logs.warn.filter((m) => m.includes(`no answer to the last ${LINK_WATCH_MISS_NOTE} status requests`)).length, 1);

  env.unit.lastCloudUpdateAt = env.now;
  await env.step();
  assert.ok(env.logs.info.some((m) => m.includes('answered a status request again')));
});

test('a few unanswered requests in a row say nothing in the Homebridge log', async () => {
  const { env } = makeWatch();
  await env.step();
  for (let i = 0; i < LINK_WATCH_MISS_NOTE - 1; i += 1) {
    await env.step();
  }
  assert.deepStrictEqual(env.logs.warn, []);
});

test('the adapter going quiet on the LAN, and coming back, are logged', async () => {
  const file = tmpFile();
  const { env } = makeWatch({ file });
  await env.step();
  env.lan = { answer: 'silent', ip: '192.168.50.142' };
  await env.step();
  await env.step();
  assert.strictEqual(env.logs.warn.filter((m) => m.includes('stopped answering on the LAN (192.168.50.142)')).length, 1);
  assert.match(readLines(file)[1], /lan=silent@192\.168\.50\.142/);

  env.lan = { answer: 'answers', ip: '192.168.50.142' };
  await env.step();
  assert.ok(env.logs.info.some((m) => m.includes('answers on the LAN again')));
});

test('the adapter checking in with the cloud is logged, but not on the first sample', async () => {
  const { env } = makeWatch();
  await env.step();
  assert.ok(!env.logs.info.some((m) => m.includes('checked in')));
  env.reportedAt += 10 * MIN;
  await env.step();
  assert.strictEqual(env.logs.info.filter((m) => m.includes('checked in with the cloud')).length, 1);
  await env.step();
  assert.strictEqual(env.logs.info.filter((m) => m.includes('checked in with the cloud')).length, 1, 'only when it moves');
});

test('the sample shows how long the temperature has sat unchanged, and No Response', async () => {
  const file = tmpFile();
  const { env } = makeWatch({ file });
  await env.step();
  await env.step();
  await env.step();
  env.unit.roomTemp = 23;
  env.unit.reachable = false;
  await env.step();
  const lines = readLines(file);
  assert.match(lines[2], /temp=22\.5 tempUnchangedMin=10 /);
  assert.match(lines[3], /temp=23 tempUnchangedMin=0 .*homekit=no-response/);
});

test('the sample file is rolled over once, not grown without limit', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'x'.repeat(LINK_WATCH_MAX_BYTES + 1));
  const { env } = makeWatch({ file });
  await env.step();
  assert.ok(fs.existsSync(`${file}.1`), 'the full file was set aside');
  assert.strictEqual(readLines(file).length, 1);
});

test('a failing probe or lookup never stops the sampling', async () => {
  const env = { asked: [] };
  const watch = new LinkWatch({
    targets: () => [{ serial: SERIAL, name: 'Front bedroom', cloudOnly: true, lastCloudUpdateAt: 0, reachable: true }],
    requestStatus: (s) => env.asked.push(s),
    streamInterruptedSince: () => false,
    lanProbe: async () => ({ answer: 'unknown' }),
    adapterReportedAt: async () => { throw new Error('cloud down'); },
    log: { info() {}, warn() {}, debug() {} },
    file: null,
  });
  await watch.tick();
  await watch.tick();
  assert.strictEqual(env.asked.length, 2);
});

// ---- platform wiring -------------------------------------------------------

const { KumoV3Platform } = require('../dist/platform.js');
const noop = () => {};

function makePlatform(extra = {}) {
  const logs = [];
  const api = {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => `uuid-${s}` } },
    platformAccessory: function PlatformAccessory() {},
    on: noop, registerPlatformAccessories: noop, updatePlatformAccessories: noop, unregisterPlatformAccessories: noop,
  };
  const platform = new KumoV3Platform({ info: (m) => logs.push(m), warn: noop, error: noop, debug: noop }, {
    name: 'test', platform: 'KumoV3', username: 'user@example.com', password: 'secret', disablePolling: true, ...extra,
  }, api);
  return { platform, logs };
}

test('the link watch only runs in debug mode', () => {
  const off = makePlatform();
  off.platform.startLinkWatch();
  assert.strictEqual(off.platform.linkWatchTimer, null);

  const on = makePlatform({ debug: true });
  on.platform.startLinkWatch();
  try {
    assert.ok(on.platform.linkWatchTimer);
    assert.ok(on.logs.some((m) => m.includes('[LINK WATCH] recording')));
  } finally {
    on.platform.cleanup();
  }
  assert.strictEqual(on.platform.linkWatchTimer, null, 'stopped at shutdown');
});

test('the LAN probe needs no stored key, and falls back to the last address that answered', async () => {
  const { platform } = makePlatform({ debug: true });
  const probed = [];
  let arp = new Map([['aa:bb:cc:dd:ee:ff', '192.168.50.142']]);
  let answer = 'kumo';
  platform.getDeviceMacs = async () => new Map([[SERIAL, 'AA:BB:CC:DD:EE:FF']]);
  platform.readArpTable = () => arp;
  platform.probeLocal = async (ip, creds) => { probed.push([ip, creds]); return answer; };

  assert.deepStrictEqual(await platform.linkWatchLanProbe(SERIAL), { answer: 'answers', ip: '192.168.50.142' });
  assert.ok(probed[0][1].password && probed[0][1].cryptoSerial, 'a placeholder key is enough to get a reply');

  arp = new Map();                                  // dropped out of the ARP cache
  answer = null;
  assert.deepStrictEqual(await platform.linkWatchLanProbe(SERIAL), { answer: 'silent', ip: '192.168.50.142' });
});

test('with no known address the LAN probe says unknown rather than silent', async () => {
  const { platform } = makePlatform({ debug: true });
  platform.getDeviceMacs = async () => new Map();
  platform.readArpTable = () => new Map();
  assert.deepStrictEqual(await platform.linkWatchLanProbe(SERIAL), { answer: 'unknown' });
});
