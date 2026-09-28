'use strict';

// Fan speed on the HeaterCooler (2.0 stage 5).
//
// HeaterCooler can't express "fan auto" (TargetFanState is a Fanv2 characteristic),
// so fan speed lives on a Fanv2 service linked to the unit's tile: RotationSpeed for
// five real speeds at 0/25/50/75/100, TargetFanState for auto/manual.
//
// Deliberate differences from the fork these tests are adapted from:
//  - Fan writes go through the same one-burst queue as power and mode, so an
//    "on, fan quiet" scene is one command and an "AC off" scene's captured fan
//    speed is dropped with the off.
//  - A fan change on its own is not sent to a unit that is off. The fork sends it
//    (it saw its units stay off); our 1.7.2 notes record a bare local write reviving
//    an off unit, and that hasn't been checked for fan writes on our hardware.
//
// Adapted from homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0,
// test/fan-service.test.js @ 44fb5f5).

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeLog, makeAccessory } = require('./helpers');

const SERIAL = 'TESTSERIAL001';
const C = Characteristic;

function makeHarness({ accessory = makeAccessory('Kitchen', SERIAL) } = {}) {
  const sent = [];
  const listened = [];
  let profileCb = null;
  const platform = { Service, Characteristic, log: makeLog(), api: { updatePlatformAccessories() {} } };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand(serial, commands) {
      sent.push(commands);
      return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  handler.onStatusUpdate((s) => listened.push(s.fanSpeed));
  const fan = accessory.getServiceById(Service.Fanv2, 'airflow');
  const tile = accessory.getService(Service.HeaterCooler);
  return { handler, accessory, fan, tile, sent, listened, applyProfile: (p) => profileCb(SERIAL, p) };
}

const profile = (over = {}) => ({
  numberOfFanSpeeds: 3, hasFanSpeedAuto: true, hasVaneDir: false, hasVaneSwing: false,
  hasModeDry: true, hasModeHeat: true, hasModeVent: true, hasDefrost: true, hasStandby: true,
  usesSetPointInDryMode: true,
  minimumSetPoints: { heat: 16, cool: 19, auto: 17 },
  maximumSetPoints: { heat: 31, cool: 30, auto: 30 },
  ...over,
});

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'low', airDirection: 'auto',
    roomTemp: 24, spCool: 23, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

// ---- Structure --------------------------------------------------------------

test('the fan is its own Fanv2 service, linked to the primary HeaterCooler', () => {
  const { fan, tile } = makeHarness();
  assert.ok(fan, 'Fanv2 service with subtype "airflow"');
  assert.strictEqual(tile.primary, true, 'the HeaterCooler is the primary service');
  assert.ok(tile.linked.includes(fan), 'the fan is linked to it');
  assert.strictEqual(tile.chars.has(C.RotationSpeed), false, 'no fan speed on the HeaterCooler itself');
});

// Found on the 2.0 rollout (2026-09-27): with the Dry and Fan Only switches left
// unlinked, the Home app grouped each unit as a heater-cooler plus two switches and
// drew the combined tile as a switch ("All Off"). Shown as separate tiles, the
// heater-cooler looked right, so the services were fine and only the grouping wasn't.
test('the Dry and Fan Only switches are linked to the HeaterCooler too', () => {
  const { accessory, tile, applyProfile } = makeHarness();
  applyProfile(profile());
  const dry = accessory.getServiceById(Service.Switch, 'dry');
  const fanOnly = accessory.getServiceById(Service.Switch, 'fan-only');
  assert.ok(dry && fanOnly, 'both switches added');
  assert.ok(tile.linked.includes(dry), 'Dry linked');
  assert.ok(tile.linked.includes(fanOnly), 'Fan Only linked');
});

test('switches restored from the 1.x cache get linked as well', () => {
  const accessory = makeAccessory('Kitchen', SERIAL);
  const cachedFan = accessory.addService(Service.Switch, 'Kitchen Fan', 'fan-only');
  const cachedDry = accessory.addService(Service.Switch, 'Kitchen Dry', 'dry');
  const { tile, applyProfile } = makeHarness({ accessory });
  applyProfile(profile());
  assert.ok(tile.linked.includes(cachedFan), 'cached Fan Only linked');
  assert.ok(tile.linked.includes(cachedDry), 'cached Dry linked');
});

test('auto/manual appears only on units with an auto fan speed', () => {
  const withAuto = makeHarness();
  withAuto.applyProfile(profile());
  assert.ok(withAuto.fan.chars.has(C.TargetFanState));

  const without = makeHarness();
  without.applyProfile(profile({ hasFanSpeedAuto: false }));
  assert.strictEqual(without.fan.chars.has(C.TargetFanState), false);
});

// ---- Slider <-> speed ---------------------------------------------------------

test('the five speeds fill the slider evenly, one position each', async () => {
  const { handler } = makeHarness();
  const expected = { superQuiet: 0, quiet: 25, low: 50, powerful: 75, superPowerful: 100 };
  for (const [speed, pct] of Object.entries(expected)) {
    handler.updateFromZone(zone({ fanSpeed: speed }));
    assert.strictEqual(await handler.getRotationSpeed(), pct, speed);
  }
});

test('each slider position sends its own speed, and 0 is the quietest, not off', async () => {
  const expected = { 0: 'superQuiet', 25: 'quiet', 50: 'low', 75: 'powerful', 100: 'superPowerful' };
  for (const [pct, speed] of Object.entries(expected)) {
    const { handler, sent } = makeHarness();
    handler.updateFromZone(zone());
    await handler.setRotationSpeed(Number(pct));
    assert.deepStrictEqual(sent, [{ fanSpeed: speed }], `slider ${pct}`);
  }
});

test('a capitalised speed reported by the unit reads back as its own position', async () => {
  const { handler } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'Low' }));
  assert.strictEqual(await handler.getRotationSpeed(), 50);
});

// ---- Auto / manual ------------------------------------------------------------

test('auto shows on TargetFanState, and the slider keeps the last real speed', async () => {
  const { handler, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));
  handler.updateFromZone(zone({ fanSpeed: 'auto' }));
  assert.strictEqual(await handler.getTargetFanState(), C.TargetFanState.AUTO);
  assert.strictEqual(await handler.getRotationSpeed(), 75, 'still at powerful, not zero');
});

test('switching to AUTO sends auto; back to MANUAL restores the last real speed', async () => {
  const { handler, sent, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));
  await handler.setTargetFanState(C.TargetFanState.AUTO);
  await handler.setTargetFanState(C.TargetFanState.MANUAL);
  assert.deepStrictEqual(sent, [{ fanSpeed: 'auto' }, { fanSpeed: 'powerful' }]);
});

test('an explicit AUTO beats a speed sent in the same burst, in either order', async () => {
  for (const order of ['auto-first', 'speed-first']) {
    const { handler, sent, applyProfile } = makeHarness();
    applyProfile(profile());
    handler.updateFromZone(zone());
    const writes = [() => handler.setTargetFanState(C.TargetFanState.AUTO), () => handler.setRotationSpeed(25)];
    if (order === 'speed-first') {
      writes.reverse();
    }
    await Promise.all(writes.map((w) => w()));
    assert.deepStrictEqual(sent, [{ fanSpeed: 'auto' }], order);
  }
});

// ---- Power ---------------------------------------------------------------------

test('the fan tile follows the unit\'s power', () => {
  const { handler, fan } = makeHarness();
  handler.updateFromZone(zone({ power: 1 }));
  assert.strictEqual(fan.getCharacteristic(C.Active).value, C.Active.ACTIVE);
  assert.strictEqual(fan.getCharacteristic(C.CurrentFanState).value, C.CurrentFanState.BLOWING_AIR);
  handler.updateFromZone(zone({ power: 0, operationMode: 'off' }));
  assert.strictEqual(fan.getCharacteristic(C.Active).value, C.Active.INACTIVE);
});

test('turning the fan tile OFF does not turn the unit off', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone());
  await handler.setFanActive(C.Active.INACTIVE);
  assert.deepStrictEqual(sent, [], 'a room-wide "turn off the fan" must not shut down the heat pump');
});

test('turning the fan tile ON turns the unit on in its last mode', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setFanActive(C.Active.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

// ---- Off units and scenes ---------------------------------------------------

test('a fan change on an off unit is not sent', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setRotationSpeed(75);
  assert.deepStrictEqual(sent, []);
});

test('"on, fan quiet" from off is one command', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await Promise.all([handler.setRotationSpeed(25), handler.setActive(C.Active.ACTIVE)]);
  assert.deepStrictEqual(sent, [{ operationMode: 'cool', fanSpeed: 'quiet' }]);
});

test('an "AC off" scene\'s captured fan speed is dropped with the off', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ fanSpeed: 'powerful' }));
  await Promise.all([handler.setRotationSpeed(25), handler.setActive(C.Active.INACTIVE)]);
  assert.deepStrictEqual(sent, [{ operationMode: 'off' }]);
});

test('a fan change just after an off (a separate burst) is not sent', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone());
  await handler.setActive(C.Active.INACTIVE);
  await handler.setRotationSpeed(100);
  assert.deepStrictEqual(sent, [{ operationMode: 'off' }]);
});

// ---- Mirror, logging, reachability --------------------------------------------

test('a HomeKit fan change notifies the mirror and is tagged homekit:fan', async () => {
  const lines = [];
  const accessory = makeAccessory('Kitchen', SERIAL);
  const { handler, listened } = makeHarness({ accessory });
  handler.platform.log = { ...makeLog(), info: (m) => lines.push(m) };
  handler.updateFromZone(zone({ fanSpeed: 'low' }));
  listened.length = 0;
  await handler.setRotationSpeed(75);
  assert.deepStrictEqual(listened, ['powerful']);
  assert.ok(lines.some((l) => /\[CMD\] Kitchen <- homekit:fan/.test(l)), JSON.stringify(lines));
});

test('No Response covers the fan tile', () => {
  const { handler, fan, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone());
  handler.setCloudConnected(false);
  for (const key of ['Active', 'RotationSpeed', 'TargetFanState', 'CurrentFanState']) {
    assert.ok(fan.getCharacteristic(C[key]).value instanceof Error, `${key} pushed No Response`);
  }
});

// ---- "Fan" switch renamed "Fan Only" ------------------------------------------

test('a cached fan-only switch with the 1.x default name becomes "Fan Only"', () => {
  const accessory = makeAccessory('Kitchen', SERIAL);
  const sw = accessory.addService(Service.Switch, 'Kitchen Fan', 'fan-only');
  sw.setCharacteristic(C.Name, 'Kitchen Fan');
  sw.setCharacteristic(C.ConfiguredName, 'Kitchen Fan');
  makeHarness({ accessory });
  assert.strictEqual(sw.getCharacteristic(C.ConfiguredName).value, 'Kitchen Fan Only');
});

// Found on the Pi 2026-09-28 by the portal-dashboard session: the front bedroom's 1.x
// switch is "Front bedroom Fan" (Name and ConfiguredName), but the unit is now called
// "Front Bedroom" in the Comfort app. Comparing against "<current unit name> Fan" read
// it as a custom name, leaving "Front bedroom Fan" (fan-only) next to the new
// "Front Bedroom Fan" (fan speed).
test('a 1.x switch whose unit was renamed since is still recognized as the default', () => {
  const accessory = makeAccessory('Front Bedroom', SERIAL);
  const sw = accessory.addService(Service.Switch, 'Front bedroom Fan', 'fan-only');
  sw.setCharacteristic(C.Name, 'Front bedroom Fan');
  sw.setCharacteristic(C.ConfiguredName, 'Front bedroom Fan');
  makeHarness({ accessory });
  assert.strictEqual(sw.getCharacteristic(C.ConfiguredName).value, 'Front Bedroom Fan Only');
  assert.strictEqual(sw.getCharacteristic(C.Name).value, 'Front Bedroom Fan Only');
});

test('a Home app rename is kept even when the plugin-set name is a 1.x default', () => {
  const accessory = makeAccessory('Front Bedroom', SERIAL);
  const sw = accessory.addService(Service.Switch, 'Front bedroom Fan', 'fan-only');
  sw.setCharacteristic(C.Name, 'Front bedroom Fan');
  sw.setCharacteristic(C.ConfiguredName, 'Bedroom breeze');
  makeHarness({ accessory });
  assert.strictEqual(sw.getCharacteristic(C.ConfiguredName).value, 'Bedroom breeze');
});

test('a fan-only switch renamed in the Home app keeps its name', () => {
  const accessory = makeAccessory('Kitchen', SERIAL);
  const sw = accessory.addService(Service.Switch, 'Kitchen Fan', 'fan-only');
  sw.setCharacteristic(C.ConfiguredName, 'Breeze');
  makeHarness({ accessory });
  assert.strictEqual(sw.getCharacteristic(C.ConfiguredName).value, 'Breeze');
});

// ---- After HomeKit stores the raw written value ---------------------------------
// hap-nodejs stores a write's value as sent AFTER onSet resolves, over anything the
// handler pushed: a slider's 30 over our 25, or a speed we declined to send to an
// off unit. The plugin republishes on a later tick. (Found by the portal-dashboard
// session driving a real hap-nodejs bridge.)

test('the slider shows the real speed position after HomeKit stores the raw value', async () => {
  const { handler, fan } = makeHarness();
  handler.updateFromZone(zone());
  await handler.setRotationSpeed(30);
  fan.getCharacteristic(C.RotationSpeed).value = 30; // what hap-nodejs does next
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(fan.getCharacteristic(C.RotationSpeed).value, 25);
});

test('a fan change not sent to an off unit snaps the slider back', async () => {
  const { handler, fan } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'off', power: 0, fanSpeed: 'low' }));
  await handler.setRotationSpeed(100);
  fan.getCharacteristic(C.RotationSpeed).value = 100;
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(fan.getCharacteristic(C.RotationSpeed).value, 50, 'back to low');
});
