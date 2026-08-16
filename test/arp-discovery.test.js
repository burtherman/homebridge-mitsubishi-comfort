'use strict';

// Unit tests for the MAC→IP discovery fast path (src/local-api.ts).
//
// The cloud reports each unit's Wi-Fi adapter MAC (GET /devices/{serial}/status),
// confirmed live 2026-08-15. parseArpTable + candidateIpsByMac turn the host's ARP
// cache into serial→IP candidates so we can skip the /24 sweep. These are the pure,
// fs-free pieces; the platform reads /proc/net/arp and verifies each candidate with
// the signed token probe (discoverDeviceIps), so a stale ARP entry can't mis-bind.

const test = require('node:test');
const assert = require('node:assert');
const { parseArpTable, candidateIpsByMac } = require('../dist/local-api.js');

const SAMPLE_ARP = [
  'IP address       HW type     Flags       HW address            Mask     Device',
  '192.168.50.253   0x1         0x2         dc:ef:ca:0a:4a:d9     *        eth0',
  '192.168.50.15    0x1         0x2         D4:53:83:49:7A:93     *        eth0', // uppercase → must lowercase
  '192.168.50.99    0x1         0x0         00:00:00:00:00:00     *        eth0', // incomplete (flags 0x0) → skip
  '192.168.50.100   0x1         0x2         00:00:00:00:00:00     *        eth0', // all-zero MAC → skip
  '',                                                                             // trailing blank line → skip
].join('\n');

test('parseArpTable maps complete entries MAC→IP, lowercased', () => {
  const t = parseArpTable(SAMPLE_ARP);
  assert.strictEqual(t.get('dc:ef:ca:0a:4a:d9'), '192.168.50.253');
  assert.strictEqual(t.get('d4:53:83:49:7a:93'), '192.168.50.15', 'MAC must be lowercased');
});

test('parseArpTable skips the header, incomplete, and all-zero rows', () => {
  const t = parseArpTable(SAMPLE_ARP);
  assert.strictEqual(t.size, 2);
  assert.strictEqual(t.has('00:00:00:00:00:00'), false);
  assert.strictEqual(t.has('ip'), false); // header not parsed as data
});

test('parseArpTable is empty on garbage / empty input', () => {
  assert.strictEqual(parseArpTable('').size, 0);
  assert.strictEqual(parseArpTable('not a table at all').size, 0);
});

test('candidateIpsByMac resolves serials whose MAC is in the table (case-insensitive)', () => {
  const macToIp = parseArpTable(SAMPLE_ARP);
  const macBySerial = new Map([
    ['LIVING', 'dc:ef:ca:0a:4a:d9'],
    ['KITCHEN', 'D4:53:83:49:7A:93'], // uppercase serial MAC still matches
    ['GHOST', 'aa:bb:cc:dd:ee:ff'],   // not in ARP → omitted
  ]);
  const out = candidateIpsByMac(macBySerial, macToIp);
  assert.strictEqual(out.get('LIVING'), '192.168.50.253');
  assert.strictEqual(out.get('KITCHEN'), '192.168.50.15');
  assert.strictEqual(out.has('GHOST'), false);
  assert.strictEqual(out.size, 2);
});

test('candidateIpsByMac tolerates an empty/absent MAC for a serial', () => {
  const macToIp = parseArpTable(SAMPLE_ARP);
  const out = candidateIpsByMac(new Map([['X', '']]), macToIp);
  assert.strictEqual(out.size, 0);
});
