'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subfamilyFor, VINTAGE_BRIDGE } = require('./subfamily-source.js');

test("OTT's own subfamily is used verbatim when it has one", () => {
  assert.equal(subfamilyFor({ subfamily: 'Miletinae', family: 'Lycaenidae' }, 'Lycaenidae'), 'Miletinae');
  assert.equal(subfamilyFor({ subfamily: 'Scolytinae', family: 'Curculionidae' }, 'Curculionidae'), 'Scolytinae');
});

test('a demoted family is bridged to its modern subfamily name', () => {
  // OTT carries the OLD concept: Lymantriidae as a FAMILY. Our corpus carries
  // the modern one, Erebidae. The modern equivalent of that rank is the
  // subfamily Lymantriinae, so that is what the column should hold.
  assert.equal(subfamilyFor({ family: 'Lymantriidae' }, 'Erebidae'), 'Lymantriinae');
});

test('the bridge also fires when our family is missing or is the OLD name too', () => {
  assert.equal(subfamilyFor({ family: 'Lymantriidae' }, null), 'Lymantriinae');
  assert.equal(subfamilyFor({ family: 'Lymantriidae' }, 'Lymantriidae'), 'Lymantriinae');
});

test('the bridge does NOT fire when our family is an unrelated third family', () => {
  // Guards against a mis-resolved row inheriting a subfamily from a taxon it
  // has nothing to do with — abstain rather than assert.
  assert.equal(subfamilyFor({ family: 'Lymantriidae' }, 'Noctuidae'), null);
});

test("OTT's own subfamily wins over the bridge", () => {
  assert.equal(subfamilyFor({ subfamily: 'Arctiinae', family: 'Lymantriidae' }, 'Erebidae'), 'Arctiinae');
});

test('no subfamily and no bridge yields null, never a guess', () => {
  assert.equal(subfamilyFor({ family: 'Erebidae' }, 'Erebidae'), null);
  assert.equal(subfamilyFor({}, 'Erebidae'), null);
  assert.equal(subfamilyFor({}, null), null);
});

test('the bridge stays deliberately tiny', () => {
  // It is a curated per-taxon translation, not a general rule. Growth should be
  // a reviewed act; a large map here means someone generalised it by accident.
  assert.ok(Object.keys(VINTAGE_BRIDGE).length <= 5, 'bridge grew unexpectedly');
});
