'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolutionPlan } = require('./sync-gbif');

test('use_globi_key only when key present AND lineage_source=globi', () => {
  assert.deepEqual(resolutionPlan({ gbif_key: 123, lineage_source: 'globi' }), { mode: 'use_globi_key', key: 123 });
});
test('match_by_name when no key', () => {
  assert.deepEqual(resolutionPlan({ gbif_key: null, lineage_source: null }), { mode: 'match_by_name', key: null });
});
test('match_by_name when key present but not GloBI-sourced', () => {
  assert.deepEqual(resolutionPlan({ gbif_key: 123, lineage_source: 'gbif_api' }), { mode: 'match_by_name', key: null });
});
