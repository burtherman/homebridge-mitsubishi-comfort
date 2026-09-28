'use strict';

// Vanes on the HeaterCooler (2.0 stage 6).
//
// The unit holds one vane field for both fixed blade angles and the two non-angle
// states ('auto', 'swing'). HomeKit gets SwingMode on the unit's own tile (units that
// report hasVaneSwing) and, opt-in, a Slats service with five tilt positions (units
// that report hasVaneDir, with exposeVaneSlat on; off by default because Apple Home
// files Slats under window coverings). Vane writes share the power/mode/fan queue,
// with the same rules as fan speed. The mirror copies the vane only to a target that
// reports it can take it.
//
// The owner's units have fixed vanes, so none of this appears on them; these tests
// and a volunteer with movable vanes (issue #6) are what cover it.
// Adapted from homebridge-mitsubishi-heatpump (ukaratay, Apache-2.0) @ 83dfd18.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeLog, makeAccessory } = require('./helpers');

const SERIAL = 'TESTSERIAL001';
const C = Characteristic;

function makeHarness({ accessory = makeAccessory('Kitchen', SERIAL), kumoConfig = {} } = {}) {
  const sent = [];
  const lines = [];
  let profileCb = null;
  const platform = {
    Service, Characteristic, kumoConfig,
    log: { ...makeLog(), info: (m) => lines.push(m) },
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
  return { handler, accessory, tile, sent, lines, applyProfile: (p) => profileCb(SERIAL, p) };
}

const profile = (over = {}) => ({
  numberOfFanSpeeds: 3, hasFanSpeedAuto: true, hasVaneDir: true, hasVaneSwing: true,
  hasModeDry: true, hasModeHeat: true, hasModeVent: true, hasDefrost: true, hasStandby: true,
  usesSetPointInDryMode: true,
  minimumSetPoints: { heat: 16, cool: 19, auto: 17 },
  maximumSetPoints: { heat: 31, cool: 30, auto: 30 },
  ...over,
});
const fixedVanes = { hasVaneDir: false, hasVaneSwing: false };

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'cool',
    fanSpeed: 'low', airDirection: 'auto',
    roomTemp: 24, spCool: 23, spHeat: 20, spAuto: null, humidity: null,
    ...over,
  },
});

// ---- What appears --------------------------------------------------------------

test('swing appears on the unit\'s tile only when the unit reports vane swing', () => {
  const swing = makeHarness();
  swing.applyProfile(profile());
  assert.ok(swing.tile.chars.has(C.SwingMode));

  const fixed = makeHarness();
  fixed.applyProfile(profile(fixedVanes));
  assert.strictEqual(fixed.tile.chars.has(C.SwingMode), false, 'units with fixed vanes get no swing control');
});

test('the tilt (Slats) control is opt-in, and needs a unit with movable vanes', () => {
  const byDefault = makeHarness();
  byDefault.applyProfile(profile());
  assert.strictEqual(byDefault.accessory.getService(Service.Slats), null, 'off by default');

  const optedIn = makeHarness({ kumoConfig: { exposeVaneSlat: true } });
  optedIn.applyProfile(profile());
  assert.ok(optedIn.accessory.getService(Service.Slats));

  const fixed = makeHarness({ kumoConfig: { exposeVaneSlat: true } });
  fixed.applyProfile(profile(fixedVanes));
  assert.strictEqual(fixed.accessory.getService(Service.Slats), null);
});

test('a cached Slats service is dropped when the option is off', () => {
  const accessory = makeAccessory('Kitchen', SERIAL);
  accessory.addService(Service.Slats, 'Kitchen Vane');
  makeHarness({ accessory });
  assert.strictEqual(accessory.getService(Service.Slats), null);
});

// ---- Reading -------------------------------------------------------------------

test('swing and tilt read back from the one vane field', async () => {
  const { handler, applyProfile } = makeHarness({ kumoConfig: { exposeVaneSlat: true } });
  applyProfile(profile());
  handler.updateFromZone(zone({ airDirection: 'swing' }));
  assert.strictEqual(await handler.getSwingMode(), C.SwingMode.SWING_ENABLED);
  assert.strictEqual(await handler.getCurrentSlatState(), C.CurrentSlatState.SWINGING);
  handler.updateFromZone(zone({ airDirection: 'midpoint' }));
  assert.strictEqual(await handler.getSwingMode(), C.SwingMode.SWING_DISABLED);
  assert.strictEqual(await handler.getTargetTiltAngle(), 0);
});

// ---- Writing -------------------------------------------------------------------

test('swing on sends swing; swing off returns to the last fixed position seen', async () => {
  const { handler, sent, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone({ airDirection: 'vertical' }));
  handler.updateFromZone(zone({ airDirection: 'swing' }));
  await handler.setSwingMode(C.SwingMode.SWING_DISABLED);
  await handler.setSwingMode(C.SwingMode.SWING_ENABLED);
  assert.deepStrictEqual(sent, [{ vaneDir: 'vertical' }, { vaneDir: 'swing' }]);
});

test('with no fixed position ever seen, swing off sends auto', async () => {
  const { handler, sent, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone({ airDirection: 'swing' }));
  await handler.setSwingMode(C.SwingMode.SWING_DISABLED);
  assert.deepStrictEqual(sent, [{ vaneDir: 'auto' }]);
});

test('each tilt angle sends its position, and in-between angles snap to the nearest', async () => {
  const expected = [[-90, 'horizontal'], [-45, 'midhorizontal'], [0, 'midpoint'], [45, 'midvertical'],
    [90, 'vertical'], [60, 'midvertical'], [-80, 'horizontal']];
  for (const [angle, vane] of expected) {
    const { handler, sent, applyProfile } = makeHarness({ kumoConfig: { exposeVaneSlat: true } });
    applyProfile(profile());
    handler.updateFromZone(zone());
    await handler.setTargetTiltAngle(angle);
    assert.deepStrictEqual(sent, [{ vaneDir: vane }], `${angle}°`);
  }
});

test('a vane change is tagged homekit:vane', async () => {
  const { handler, lines, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone());
  await handler.setSwingMode(C.SwingMode.SWING_ENABLED);
  assert.ok(lines.some((l) => /\[CMD\] Kitchen <- homekit:vane/.test(l)), JSON.stringify(lines));
});

// ---- Off units and scenes --------------------------------------------------------

test('a vane change on an off unit is not sent', async () => {
  const { handler, sent, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setSwingMode(C.SwingMode.SWING_ENABLED);
  assert.deepStrictEqual(sent, []);
});

test('"on, swing" from off is one command; an off scene\'s captured swing is dropped', async () => {
  const on = makeHarness();
  on.applyProfile(profile());
  on.handler.updateFromZone(zone({ operationMode: 'cool' }));
  on.handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await Promise.all([on.handler.setSwingMode(C.SwingMode.SWING_ENABLED), on.handler.setActive(C.Active.ACTIVE)]);
  assert.deepStrictEqual(on.sent, [{ operationMode: 'cool', vaneDir: 'swing' }]);

  const off = makeHarness();
  off.applyProfile(profile());
  off.handler.updateFromZone(zone({ airDirection: 'vertical' }));
  await Promise.all([off.handler.setSwingMode(C.SwingMode.SWING_ENABLED), off.handler.setActive(C.Active.INACTIVE)]);
  assert.deepStrictEqual(off.sent, [{ operationMode: 'off' }]);
});

// ---- Mirror -----------------------------------------------------------------------

test('the mirror sends the vane to a target that has movable vanes', async () => {
  const { handler, sent, applyProfile } = makeHarness();
  applyProfile(profile());
  handler.updateFromZone(zone());
  await handler.applyMirror({ operationMode: 'cool', power: 1, spHeat: 20, spCool: 23, fanSpeed: '', airDirection: 'swing' });
  assert.deepStrictEqual(sent, [{ operationMode: 'cool', spCool: 23, vaneDir: 'swing' }]);
});

test('the mirror sends no vane to a fixed-vane target, or before the target\'s profile arrives', async () => {
  const fixed = makeHarness();
  fixed.applyProfile(profile(fixedVanes));
  fixed.handler.updateFromZone(zone());
  await fixed.handler.applyMirror({ operationMode: 'cool', power: 1, spHeat: 20, spCool: 23, fanSpeed: '', airDirection: 'swing' });
  assert.deepStrictEqual(fixed.sent, [{ operationMode: 'cool', spCool: 23 }]);

  const noProfile = makeHarness();
  noProfile.handler.updateFromZone(zone());
  await noProfile.handler.applyMirror({ operationMode: 'cool', power: 1, spHeat: 20, spCool: 23, fanSpeed: '', airDirection: 'vertical' });
  assert.deepStrictEqual(noProfile.sent, [{ operationMode: 'cool', spCool: 23 }]);
});

// ---- Reachability -------------------------------------------------------------------

test('No Response covers swing and the tilt control', () => {
  const { handler, tile, accessory, applyProfile } = makeHarness({ kumoConfig: { exposeVaneSlat: true } });
  applyProfile(profile());
  handler.updateFromZone(zone());
  handler.setCloudConnected(false);
  assert.ok(tile.getCharacteristic(C.SwingMode).value instanceof Error);
  const slats = accessory.getService(Service.Slats);
  for (const key of ['CurrentSlatState', 'CurrentTiltAngle', 'TargetTiltAngle']) {
    assert.ok(slats.getCharacteristic(C[key]).value instanceof Error, key);
  }
});
