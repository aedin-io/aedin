'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planDedup } = require('./dedup-entity-trait-claims');

// Minimal row factory mirroring entity_trait_claims columns the planner reads.
function row(id, entity_id, trait_name, value, source_id, source_quote = 'q') {
  const r = { id, entity_id, trait_name, source_id, source_quote,
    value_numeric: null, value_text: null, value_json: null };
  if (typeof value === 'number') r.value_numeric = value;
  else if (Array.isArray(value) || (value && typeof value === 'object')) r.value_json = JSON.stringify(value);
  else r.value_text = value;
  return r;
}

test('collapses exact duplicates (same entity+trait+value+source) keeping one', () => {
  const { deletions, conflicts } = planDedup([
    row(1, 100, 'life_cycle', 'annual', 38),
    row(2, 100, 'life_cycle', 'annual', 38),
  ]);
  assert.deepEqual(deletions, [2]); // keep MIN id when quotes equal
  assert.equal(conflicts.length, 0);
});

test('keeps same value from DIFFERENT sources (corroboration, not a dup)', () => {
  const { deletions, conflicts } = planDedup([
    row(1, 100, 'life_cycle', 'annual', 38),
    row(2, 100, 'life_cycle', 'annual', 41),
  ]);
  assert.deepEqual(deletions, []);
  assert.equal(conflicts.length, 0);
});

test('flags cross-value conflict (same entity+trait, differing values) and deletes nothing', () => {
  const { deletions, conflicts } = planDedup([
    row(1, 100, 'ph_max', 6.0, 38),
    row(2, 100, 'ph_max', 8.0, 38),
  ]);
  assert.deepEqual(deletions, []);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].entity_id, 100);
  assert.equal(conflicts[0].trait_name, 'ph_max');
  assert.equal(conflicts[0].values.length, 2);
});

test('within an exact-dup pair, prefers the row WITH a source_quote over a quote-less one', () => {
  const { deletions } = planDedup([
    row(1, 100, 'life_cycle', 'annual', 38, null), // lower id but no quote
    row(2, 100, 'life_cycle', 'annual', 38, 'Source says annual'),
  ]);
  assert.deepEqual(deletions, [1]); // delete the quote-less one, keep the quoted
});

test('collapses exact dups even inside a conflicted group, while still flagging the conflict', () => {
  const { deletions, conflicts } = planDedup([
    row(1, 100, 'edible_part', ['fruit'], 38),
    row(2, 100, 'edible_part', ['fruit'], 38),          // exact dup of #1
    row(3, 100, 'edible_part', ['fruit', 'leaf'], 38),  // different value -> conflict
  ]);
  assert.deepEqual(deletions, [2]);     // the exact dup collapses
  assert.equal(conflicts.length, 1);    // the value disagreement is flagged
});
