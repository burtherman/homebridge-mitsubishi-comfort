'use strict';

// When the cloud stream drops, the plugin falls back to polling the cloud. With
// `disablePolling` (the recommended setting) no poller exists until then, and the
// fallback only restarted existing ones: on 2026-10-01 it logged "0 site poller(s)
// active at 10s intervals" through two drops and nothing polled. Cloud-only units
// (the front bedroom) got no updates at all while the stream was down.

const test = require('node:test');
const assert = require('node:assert');
const { KumoV3Platform } = require('../dist/platform.js');
const { KumoAPI } = require('../dist/kumo-api.js');

const noop = () => {};

function makeApi() {
  return {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s) => `uuid-${s}` } },
    platformAccessory: function PlatformAccessory() {},
    on: noop,
    registerPlatformAccessories: noop,
    updatePlatformAccessories: noop,
    unregisterPlatformAccessories: noop,
  };
}

function makePlatform(extra = {}) {
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: noop, debug: noop };
  const platform = new KumoV3Platform(log, {
    name: 'test', platform: 'KumoV3', username: 'user@example.com', password: 'secret',
    disablePolling: true, ...extra,
  }, makeApi());
  const updates = [];
  platform.accessoryHandlers.push({
    getSiteId: () => 'site-1',
    getDeviceSerial: () => 'S1',
    updateFromZone: (zone) => updates.push(zone),
  });
  platform.kumoAPI.getZones = async () => [{ adapter: { deviceSerial: 'S1' } }];
  return { platform, logs, updates };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stream drop starts polling even when disablePolling is on', async () => {
  const { platform, logs, updates } = makePlatform();
  platform.handleStreamingHealthChange(true);
  platform.handleStreamingHealthChange(false);
  try {
    assert.strictEqual(platform.sitePollers.size, 1, 'one poller for the one site');
    assert.ok(logs.some((m) => m.includes('1 site poller(s) active')));
    await sleep(5);
    assert.strictEqual(updates.length, 1, 'polled right away and handed the zone to the unit');
  } finally {
    platform.stopAllPollers();
  }
});

test('with disablePolling the pollers stop again when the stream is back', () => {
  const { platform } = makePlatform();
  platform.handleStreamingHealthChange(true);
  platform.handleStreamingHealthChange(false);
  platform.exitDegradedMode();
  assert.strictEqual(platform.sitePollers.size, 0);
});

test('without disablePolling the existing poller is kept, not doubled', () => {
  const { platform } = makePlatform({ disablePolling: false, pollInterval: 3600 });
  platform.isDegradedMode = false;
  platform.startSitePoller('site-1');
  try {
    platform.handleStreamingHealthChange(true);
    platform.handleStreamingHealthChange(false);
    assert.strictEqual(platform.sitePollers.size, 1);
  } finally {
    platform.stopAllPollers();
  }
});

test('streamInterruptedSince: down now, or reconnected since the given time', () => {
  const api = new KumoAPI('user@example.com', 'pw', { info: noop, warn: noop, error: noop, debug: noop }, false, true);
  api.socket = null;
  assert.strictEqual(api.streamInterruptedSince(Date.now()), true, 'no socket');

  api.socket = { connected: true };
  api.streamUpSince = Date.now() - 60000;
  assert.strictEqual(api.streamInterruptedSince(Date.now() - 1000), false, 'up the whole time');
  assert.strictEqual(api.streamInterruptedSince(Date.now() - 120000), true, 'reconnected within the span');

  api.socket = { connected: false };
  assert.strictEqual(api.streamInterruptedSince(Date.now() - 1000), true, 'down now');
});
