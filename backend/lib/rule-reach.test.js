'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyReach } = require('./rule-reach.js');

test('a rule matching entities is LIVE', () => {
  assert.equal(classifyReach({ matched: 4200, ruleRank: 'family', altRanks: {} }).status, 'live');
});

test('a rule matching nothing whose value IS a taxon at another rank is a RANK MISMATCH', () => {
  // glomeromycota is stored with match_field='family' but is a phylum, so the
  // family comparison can never fire. The rule looks like coverage and is inert.
  const r = classifyReach({ matched: 0, ruleRank: 'family', altRanks: { phylum: 227 } });
  assert.equal(r.status, 'rank_mismatch');
  assert.equal(r.foundAt, 'phylum');
  assert.equal(r.reachable, 227);
});

test('a rule matching nothing whose value is a DEMOTED family is a VINTAGE MISMATCH', () => {
  // OTT/older schemes keep Lymantriidae at family rank; our corpus uses the
  // modern Erebidae and records Lymantriinae as the subfamily.
  const r = classifyReach({ matched: 0, ruleRank: 'family', altRanks: { subfamily: 293 } });
  assert.equal(r.status, 'vintage_mismatch');
  assert.equal(r.foundAt, 'subfamily');
  assert.equal(r.reachable, 293);
});

test('a rule matching nothing found at no other rank is simply DEAD', () => {
  const r = classifyReach({ matched: 0, ruleRank: 'family', altRanks: {} });
  assert.equal(r.status, 'dead');
  assert.equal(r.reachable, 0);
});

test('a thin rule is reported but is NOT a defect', () => {
  // Low reach can be legitimate — a small family is still a family.
  const r = classifyReach({ matched: 6, ruleRank: 'family', altRanks: { subfamily: 293 } });
  assert.equal(r.status, 'underreaching');
  assert.equal(r.reachable, 293);
});

test('subfamily is preferred over a coarser rank when the value appears at both', () => {
  // Prefer the FINER rank: re-keying to phylum would widen a family rule's
  // reach far beyond what was ever curated.
  const r = classifyReach({ matched: 0, ruleRank: 'family', altRanks: { subfamily: 12, phylum: 900 } });
  assert.equal(r.foundAt, 'subfamily');
});

test('demotedForms maps a family name to the subfamily name it becomes', () => {
  const { demotedForms } = require('./rule-reach.js');
  // Zoological demotion renames as well as re-ranks: -idae -> -inae. Looking up
  // the UNCHANGED string at other ranks therefore finds nothing, which is why
  // the first version of this audit missed both cases that motivated it.
  assert.deepEqual(demotedForms('lymantriidae'), ['lymantriinae']);
  assert.deepEqual(demotedForms('scolytidae'), ['scolytinae']);
  assert.deepEqual(demotedForms('curculionidae'), ['curculioninae']);
  assert.deepEqual(demotedForms('asteraceae'), [], 'botanical -aceae has no -inae demotion');
  assert.deepEqual(demotedForms(''), []);
});

test('a renamed demotion is caught as a vintage mismatch', () => {
  const r = classifyReach({ matched: 0, ruleRank: 'family', altRanks: {}, demotedAt: { subfamily: 162 } });
  assert.equal(r.status, 'vintage_mismatch');
  assert.equal(r.foundAt, 'subfamily');
  assert.equal(r.reachable, 162);
});

test('a renamed demotion that still matches a few is UNDER-REACHING', () => {
  // lymantriidae reaches 6 by family while 293 sit under Lymantriinae.
  const r = classifyReach({ matched: 6, ruleRank: 'family', altRanks: {}, demotedAt: { subfamily: 293 } });
  assert.equal(r.status, 'underreaching');
  assert.equal(r.reachable, 293);
});
