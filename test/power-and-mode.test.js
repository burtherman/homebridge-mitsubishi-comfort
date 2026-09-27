'use strict';

// Power and mode on the HeaterCooler (2.0).
//
// 1. Off must always be a real transition. The 1.7.1 bug: on the Thermostat, a unit
//    running in dry or fan-only read as OFF, so a scene's "set Off" was suppressed by
//    iOS as redundant and the unit kept running. On HeaterCooler, power is `Active`,
//    separate from the mode, and a running dry/vent unit reads ACTIVE — so an off
//    scene is always a 1 -> 0 write.
//
// 2. Power-on restores the unit's last real mode. HomeKit sends Active=1 with no mode;
//    an off unit reports mode 'off'. The fork this code came from fell back to AUTO,
//    so every unit turned on in AUTO. The last active mode is kept in accessory
//    context (persisted by Homebridge) and seeded from the cloud's
//    previousOperationMode when nothing is remembered.
//
// 3. One scene burst, one command. hap-nodejs dispatches a write request's handlers
//    concurrently, so "on, cool, 72" arrives as Active=1, TargetHeaterCoolerState=COOL
//    and CoolingThreshold=72°F in any order. Sent separately, power-on picked its own
//    mode and raced the explicit one, and the setpoint (written while the unit was
//    still off) was cached and never sent. They're now combined into one command.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeLog, makeAccessory } = require('./helpers');

const SERIAL = 'TESTSERIAL001';
const A = Characteristic.Active;
const T = Characteristic.TargetHeaterCoolerState;
const S = Characteristic.CurrentHeaterCoolerState;

function makeHarness({ accessory = makeAccessory('Kitchen', SERIAL) } = {}) {
  const sent = [];
  let profileCb = null;
  const platform = {
    Service,
    Characteristic,
    log: makeLog(),
    api: { updatePlatformAccessories() {} },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand(serial, commands) {
      sent.push(commands);
      return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  const tile = accessory.getService(Service.HeaterCooler);
  return { handler, accessory, tile, sent, applyProfile: (p) => profileCb(SERIAL, p) };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'dry',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 25, spHeat: 23, spAuto: null, humidity: null,
    ...over,
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Off is always a real transition -----------------------------------

test('a unit running in DRY reports Active ACTIVE, so an off scene is a real 1 -> 0', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));
  assert.strictEqual(await handler.getActive(), A.ACTIVE);
});

test('a unit running in fan-only VENT reports Active ACTIVE', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'vent', power: 1 }));
  assert.strictEqual(await handler.getActive(), A.ACTIVE);
});

test('a powered-off unit reports INACTIVE (control)', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  assert.strictEqual(await handler.getActive(), A.INACTIVE);
  assert.strictEqual(await handler.getCurrentHeaterCoolerState(), S.INACTIVE);
});

test('Active OFF on a dry unit sends operationMode off', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry', power: 1 }));
  await handler.setActive(A.INACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'off' }]);
});

test('current state: dry cools, fan-only is IDLE, heat heats', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'dry' }));
  assert.strictEqual(await handler.getCurrentHeaterCoolerState(), S.COOLING);
  handler.updateFromZone(zone({ operationMode: 'vent' }));
  assert.strictEqual(await handler.getCurrentHeaterCoolerState(), S.IDLE);
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  assert.strictEqual(await handler.getCurrentHeaterCoolerState(), S.HEATING);
});

test('standby shows as IDLE on the tile from the same update that reports it', () => {
  const { handler, tile } = makeHarness();
  handler.updateFromLocal({ operationMode: 'heat', power: 1, roomTemp: 22, spHeat: 23, spCool: 25, standby: false });
  assert.strictEqual(tile.getCharacteristic(S).value, S.HEATING);
  handler.updateFromLocal({ operationMode: 'heat', power: 1, roomTemp: 22, spHeat: 23, spCool: 25, standby: true });
  assert.strictEqual(tile.getCharacteristic(S).value, S.IDLE, 'not one update late');
});

test('target state: dry and fan-only read COOL, heat HEAT, autoHeat AUTO', async () => {
  const { handler } = makeHarness();
  for (const [mode, expected] of [['dry', T.COOL], ['vent', T.COOL], ['heat', T.HEAT], ['autoHeat', T.AUTO]]) {
    handler.updateFromZone(zone({ operationMode: mode }));
    assert.strictEqual(await handler.getTargetHeaterCoolerState(), expected, mode);
  }
});

test('turning the Dry switch on shows the tile ACTIVE immediately', async () => {
  const { handler, tile } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setDryOn(true);
  assert.strictEqual(tile.getCharacteristic(Characteristic.Active).value, A.ACTIVE);
});

// ---- 2. Power-on restores the last real mode ------------------------------

test('power-on restores the last active mode, not AUTO', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat', power: 1 }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

test('while off, the tile shows the mode power-on will restore', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat', power: 1 }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), T.HEAT);
});

test('the remembered mode survives a restart (kept in accessory context)', async () => {
  const accessory = makeAccessory('Kitchen', SERIAL);
  const first = makeHarness({ accessory });
  first.handler.updateFromZone(zone({ operationMode: 'cool', power: 1 }));

  const second = makeHarness({ accessory }); // a new process, same cached accessory
  second.handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await second.handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(second.sent, [{ operationMode: 'cool' }]);
});

test('with nothing remembered, the cloud\'s previousOperationMode seeds power-on', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0, previousOperationMode: 'heat' }));
  await handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

test('with no history at all, power-on uses AUTO, or COOL on a cooling-only unit', async () => {
  const one = makeHarness();
  one.handler.updateFromZone(zone({ operationMode: 'off', power: 0, previousOperationMode: 'off' }));
  await one.handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(one.sent, [{ operationMode: 'auto' }]);

  const two = makeHarness();
  two.applyProfile({
    numberOfFanSpeeds: 3, hasFanSpeedAuto: true, hasVaneDir: false, hasVaneSwing: false,
    hasModeDry: false, hasModeHeat: false, hasModeVent: false, hasDefrost: false, hasStandby: false,
    usesSetPointInDryMode: false,
    minimumSetPoints: { heat: 16, cool: 19, auto: 17 }, maximumSetPoints: { heat: 31, cool: 30, auto: 30 },
  });
  two.handler.updateFromZone(zone({ operationMode: 'off', power: 0, previousOperationMode: 'off' }));
  await two.handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(two.sent, [{ operationMode: 'cool' }]);
});

// ---- 3. One scene burst, one command --------------------------------------

test('"AC off" scene: Active=0 plus its captured mode sends one off, in either order', async () => {
  for (const order of ['off-first', 'mode-first']) {
    const { handler, sent } = makeHarness();
    handler.updateFromZone(zone({ operationMode: 'cool', power: 1 }));
    const writes = order === 'off-first'
      ? [() => handler.setActive(A.INACTIVE), () => handler.setTargetHeaterCoolerState(T.COOL)]
      : [() => handler.setTargetHeaterCoolerState(T.COOL), () => handler.setActive(A.INACTIVE)];
    await Promise.all(writes.map((w) => w()));
    assert.deepStrictEqual(sent, [{ operationMode: 'off' }], order);
  }
});

test('"AC on, heat" scene from off lands in heat, in either order', async () => {
  for (const order of ['on-first', 'mode-first']) {
    const { handler, sent } = makeHarness();
    handler.updateFromZone(zone({ operationMode: 'cool', power: 1 })); // remembered: cool
    handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
    const writes = order === 'on-first'
      ? [() => handler.setActive(A.ACTIVE), () => handler.setTargetHeaterCoolerState(T.HEAT)]
      : [() => handler.setTargetHeaterCoolerState(T.HEAT), () => handler.setActive(A.ACTIVE)];
    await Promise.all(writes.map((w) => w()));
    assert.deepStrictEqual(sent, [{ operationMode: 'heat' }], order);
  }
});

test('"AC on, cool 72" from off sends mode and setpoint as one command', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await Promise.all([
    handler.setCoolingThresholdTemperature((72 - 32) * 5 / 9),
    handler.setActive(A.ACTIVE),
    handler.setTargetHeaterCoolerState(T.COOL),
  ]);
  await sleep(1700); // past the setpoint hold: nothing else may follow
  assert.deepStrictEqual(sent, [{ operationMode: 'cool', spCool: 22.3 }]);
  assert.strictEqual(await handler.getCoolingThresholdTemperature(), 22.3);
});

test('a setpoint written while off in an EARLIER burst is not applied at power-on', async () => {
  // An "AC off" scene re-sends stale captured setpoints; applying those at the next
  // power-on would rewrite the stored setpoint (the 1.8.2 bug).
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool', power: 1, spCool: 23 }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0, spCool: 23 }));
  await handler.setCoolingThresholdTemperature(25);
  await sleep(1100);
  await handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'cool' }]);
});

test('picking a mode on an off unit turns it on in that mode', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setTargetHeaterCoolerState(T.HEAT);
  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

test('a mode arriving just after an off (a separate burst) does not revive the unit', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool', power: 1 }));
  await handler.setActive(A.INACTIVE);
  await handler.setTargetHeaterCoolerState(T.COOL);
  assert.deepStrictEqual(sent, [{ operationMode: 'off' }]);
});
