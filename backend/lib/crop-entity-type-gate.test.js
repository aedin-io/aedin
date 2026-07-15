'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cropSlotVerdict } = require('./crop-entity-type-gate');

test('CONFIRMED animals (real animal kingdom) in a crop slot are rejected', () => {
  assert.strictEqual(cropSlotVerdict('invertebrate', 'Animalia').allowed, false);
  assert.strictEqual(cropSlotVerdict('invertebrate', 'Animalia').severity, 'reject');
  assert.strictEqual(cropSlotVerdict('vertebrate', 'Metazoa').allowed, false);
  assert.strictEqual(cropSlotVerdict('Vertebrate', 'metazoa').severity, 'reject'); // case-insensitive
});

test('animal bio_category with UNCONFIRMED kingdom is FLAGGED, not rejected (corruption guard)', () => {
  // The documented bug: a plant (Lycopersicon esculentum) mis-tagged invertebrate with NULL kingdom.
  const v = cropSlotVerdict('invertebrate', null);
  assert.strictEqual(v.allowed, true, 'must NOT reject — could be a mis-tagged plant');
  assert.strictEqual(v.severity, 'flag');
  assert.strictEqual(cropSlotVerdict('invertebrate', '').severity, 'flag');
  assert.strictEqual(cropSlotVerdict('invertebrate', 'Plantae').severity, 'flag'); // contradictory tag → don't trust
});

test('plants and fungi are allowed (ok)', () => {
  assert.strictEqual(cropSlotVerdict('plantae', 'Plantae').allowed, true);
  assert.strictEqual(cropSlotVerdict('plantae', 'Plantae').severity, 'ok');
  assert.strictEqual(cropSlotVerdict('fungi', 'Fungi').severity, 'ok');
});

test('microbe is flagged, not rejected', () => {
  const v = cropSlotVerdict('microbe', 'Bacteria');
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.severity, 'flag');
});

test('unknown / null / other bio_category is NOT rejected (avoid false positives)', () => {
  assert.strictEqual(cropSlotVerdict(null, null).allowed, true);
  assert.strictEqual(cropSlotVerdict(undefined, undefined).allowed, true);
  assert.strictEqual(cropSlotVerdict('', '').allowed, true);
  assert.strictEqual(cropSlotVerdict('other', null).allowed, true);
  assert.strictEqual(cropSlotVerdict('   ', null).severity, 'ok');
});
