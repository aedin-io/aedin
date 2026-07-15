'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inheritanceRefreshSql } = require('./gen-inheritance-refresh.cjs');

// A minimal build read-subset (the shape build-d1.cjs::selectReadSubset returns).
// The materialization (synthetic ids, served scope, inheritance guards) is
// build-d1.cjs's job — covered by its own tests. This tests only that the
// refresh tool isolates the inherited subset and emits a clean full-replace.
function subset() {
  return {
    traitClaims: [
      // OWN claim (inherited_from_entity_id null) — must be EXCLUDED.
      { id: 5, entity_id: 100, trait_name: 'ph_min', value_numeric: 6, value_text: null, value_json: null, source_id: 72, inherited_from_entity_id: null },
      // INHERITED claim (synthetic id = 100*1e9 + 5) — must be INCLUDED.
      { id: 100000000005, entity_id: 100, trait_name: 'ph_min', value_numeric: 6, value_text: null, value_json: null, source_id: 72, inherited_from_entity_id: 50 },
    ],
    entities: [
      { id: 100, scientific_name: 'Solanum tuberosum var. x' }, // the inheriting variety
      { id: 999, scientific_name: 'Unrelated entity' },          // not referenced — EXCLUDED
    ],
    sources: [
      { id: 72, title: 'Trefle API' }, // cited by the inherited claim — INCLUDED
      { id: 99, title: 'Other source' }, // not cited — EXCLUDED
    ],
  };
}

test('isolates the inherited subset and counts it', () => {
  const { counts } = inheritanceRefreshSql(subset());
  assert.equal(counts.inherited, 1);
  assert.equal(counts.varieties, 1);
  assert.equal(counts.sources, 1);
});

test('emits DELETE of the whole inherited subset before re-inserting', () => {
  const { sql } = inheritanceRefreshSql(subset());
  const delIdx = sql.indexOf('DELETE FROM entity_trait_claims WHERE inherited_from_entity_id IS NOT NULL;');
  const insIdx = sql.indexOf('INSERT INTO entity_trait_claims');
  assert.ok(delIdx > -1, 'has the inherited-subset DELETE');
  assert.ok(insIdx > delIdx, 'inserts come AFTER the delete');
});

test('re-inserts only inherited rows (own claims excluded), keeping synthetic ids', () => {
  const { sql } = inheritanceRefreshSql(subset());
  assert.match(sql, /INSERT INTO entity_trait_claims [^\n]*VALUES \(100000000005,/); // the inherited row, synthetic id preserved
  assert.doesNotMatch(sql, /INSERT INTO entity_trait_claims [^\n]*VALUES \(5,/);       // the own row is NOT re-inserted here
});

test('scopes entities + sources to those the inherited rows reference, via OR IGNORE (never overwrite)', () => {
  const { sql } = inheritanceRefreshSql(subset());
  assert.match(sql, /INSERT OR IGNORE INTO entities [^\n]*VALUES \(100,/);
  assert.doesNotMatch(sql, /VALUES \(999,/);
  assert.match(sql, /INSERT OR IGNORE INTO sources [^\n]*VALUES \(72,/);
  assert.doesNotMatch(sql, /VALUES \(99,/);
});

test('empty subset yields a DELETE with no inserts (safe no-op refresh)', () => {
  const { sql, counts } = inheritanceRefreshSql({ traitClaims: [], entities: [], sources: [] });
  assert.equal(counts.inherited, 0);
  assert.match(sql, /DELETE FROM entity_trait_claims WHERE inherited_from_entity_id IS NOT NULL;/);
  assert.doesNotMatch(sql, /INSERT INTO entity_trait_claims/);
});
