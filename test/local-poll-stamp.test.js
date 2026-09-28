'use strict';

// The local poller must stamp each read before it starts, so the accessory can
// drop a read that a command overtook (see local-integration.test.js, "a read that
// started before our command").

const test = require('node:test');
const assert = require('node:assert');
const { KumoV3Platform } = require('../dist/platform.js');

const SERIAL = 'SERIAL-A';
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

test('the local poller passes the time the read started, not when it finished', async () => {
  const platform = new KumoV3Platform({ info: noop, warn: noop, error: noop, debug: noop }, {
    name: 'test', platform: 'KumoV3', username: 'user@example.com', password: 'secret',
    disablePolling: true, localControl: true, localPollInterval: 3600,
  }, makeApi());

  let readCalledAt = 0;
  platform.localClient = {
    hasLocal: () => true,
    async getStatus() {
      readCalledAt = Date.now();
      await new Promise((r) => setTimeout(r, 30));
      return { roomTemp: 21, operationMode: 'heat', power: 1 };
    },
    async getHumidity() { return null; },
  };
  const applied = [];
  platform.accessoryHandlers = [{
    getDeviceSerial: () => SERIAL,
    updateFromLocal: (status, readStartedAt) => applied.push({ status, readStartedAt, at: Date.now() }),
  }];

  platform.startLocalPolling();
  await new Promise((r) => setTimeout(r, 60));
  clearInterval(platform.localPollTimer);

  assert.strictEqual(applied.length, 1);
  assert.strictEqual(typeof applied[0].readStartedAt, 'number');
  assert.ok(applied[0].readStartedAt <= readCalledAt, 'stamped before the read was issued');
  assert.ok(applied[0].at - applied[0].readStartedAt >= 25, 'and not at the time it was applied');
});
