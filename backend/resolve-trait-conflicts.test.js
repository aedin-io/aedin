'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planResolve } = require('./resolve-trait-conflicts');

const KIND = {
  edible_part: 'list', host_range: 'list',
  ph_min: 'numeric', ph_max: 'numeric',
  commercial_biocontrol: 'boolean',
  growth_habit: 'categorical', pest_mobility: 'categorical', produce_shape: 'categorical',
};

function row(id, entity_id, trait_name, value, source_id, source_quote = 'q') {
  const r = { id, entity_id, trait_name, source_id, source_quote,
    value_numeric: null, value_text: null, value_json: null };
  if (typeof value === 'number') r.value_numeric = value;
  else if (Array.isArray(value)) r.value_json = JSON.stringify(value);
  else r.value_text = value;
  return r;
}

test('LIST: keeps the superset claim, deletes strict subsets', () => {
  const { deletions, flags } = planResolve([
    row(1, 10, 'edible_part', ['fruit'], 38),
    row(2, 10, 'edible_part', ['fruit', 'leaf', 'stem'], 38),
  ], KIND);
  assert.deepEqual(deletions, [1]);
  assert.equal(flags.length, 0);
});

test('LIST: preserves BOTH multi-source superset claims, deletes only the subset', () => {
  const { deletions } = planResolve([
    row(1, 10, 'edible_part', ['fruit'], 38),
    row(2, 10, 'edible_part', ['fruit', 'leaf'], 38),
    row(3, 10, 'edible_part', ['fruit', 'leaf'], 41), // same superset value, different source
  ], KIND);
  assert.deepEqual(deletions, [1]); // keep 2 AND 3 (corroboration), drop only the subset
});

test('LIST: partial overlap (no superset) is flagged, deletes nothing', () => {
  const { deletions, flags } = planResolve([
    row(1, 10, 'edible_part', ['fruit', 'leaf'], 38),
    row(2, 10, 'edible_part', ['fruit', 'stem'], 38),
  ], KIND);
  assert.deepEqual(deletions, []);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].reason, 'list_partial_overlap');
});

test('NUMERIC: keeps ALL distinct values (range endpoints), deletes nothing', () => {
  const { deletions, flags } = planResolve([
    row(1, 10, 'ph_min', 5.5, 38, null),
    row(2, 10, 'ph_min', 6.0, 38, 'pH 6'),
  ], KIND);
  assert.deepEqual(deletions, []); // both kept — they are a range, aggregated at serving
  assert.equal(flags.length, 0);
});

test('NUMERIC: far-apart values are also kept (may be a stated range), not flagged', () => {
  const { deletions, flags } = planResolve([
    row(1, 10, 'ph_max', 6.0, 38),
    row(2, 10, 'ph_max', 8.0, 38), // same source — could be the bounds of an optimal range
  ], KIND);
  assert.deepEqual(deletions, []);
  assert.equal(flags.length, 0);
});

test('BOOLEAN: drops a non-boolean junk value, keeps the valid boolean', () => {
  const { deletions } = planResolve([
    row(1, 10, 'commercial_biocontrol', 'commercial', 38),
    row(2, 10, 'commercial_biocontrol', 'true', 38),
  ], KIND);
  assert.deepEqual(deletions, [1]);
});

test('BOOLEAN: same-source true-vs-false inconsistency is flagged', () => {
  const { deletions, flags } = planResolve([
    row(1, 10, 'commercial_biocontrol', 'true', 38),
    row(2, 10, 'commercial_biocontrol', 'false', 38), // same source contradicts itself
  ], KIND);
  assert.deepEqual(deletions, []);
  assert.equal(flags[0].reason, 'boolean_genuine');
});

test('CATEGORICAL: substring granularity keeps the richest, deletes the substring', () => {
  const { deletions } = planResolve([
    row(1, 10, 'growth_habit', 'tree', 38),
    row(2, 10, 'growth_habit', 'tree/shrub', 38),
  ], KIND);
  assert.deepEqual(deletions, [1]);
});

test('CATEGORICAL: pest_mobility none/sedentary normalizes to sedentary', () => {
  const { deletions } = planResolve([
    row(1, 10, 'pest_mobility', 'none', 38),
    row(2, 10, 'pest_mobility', 'sedentary', 38),
  ], KIND);
  assert.deepEqual(deletions, [1]); // keep sedentary
});

test('CATEGORICAL: genuine disagreement (oblate vs round) is flagged', () => {
  const { deletions, flags } = planResolve([
    row(1, 10, 'produce_shape', 'oblate', 38),
    row(2, 10, 'produce_shape', 'round', 38),
  ], KIND);
  assert.deepEqual(deletions, []);
  assert.equal(flags[0].reason, 'categorical_genuine');
});

test('SOURCE-AWARE: a categorical disagreement from DIFFERENT sources is NOT flagged (legitimate provenance)', () => {
  const { deletions, flags, legitMultiSource } = planResolve([
    row(1, 10, 'produce_shape', 'oblate', 38),
    row(2, 10, 'produce_shape', 'round', 41), // different source — two readings
  ], KIND);
  assert.deepEqual(deletions, []);
  assert.equal(flags.length, 0);
  assert.equal(legitMultiSource, 1);
});

test('SOURCE-AWARE: same-source categorical inconsistency IS flagged even amid multi-source rows', () => {
  const { flags } = planResolve([
    row(1, 10, 'produce_shape', 'oblate', 38),
    row(2, 10, 'produce_shape', 'round', 38), // SAME source contradicts itself
    row(3, 10, 'produce_shape', 'oval', 41),
  ], KIND);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].reason, 'categorical_genuine');
});
