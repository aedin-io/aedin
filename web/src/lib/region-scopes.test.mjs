import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SCOPE_COUNTRIES, COARSE_REGION_TO_SCOPES } from './region-scopes.js';

const require = createRequire(import.meta.url);
const regions = require('../../../backend/regions.json');
const VALID = new Set(Object.keys(regions));

test('every mapped country is a real regions.json key (typo guard)', () => {
  for (const [scope, countries] of Object.entries(SCOPE_COUNTRIES)) {
    for (const c of countries) assert.ok(VALID.has(c), `${scope}: "${c}" is not a regions.json country`);
  }
});

test('spot-check memberships', () => {
  assert.ok(SCOPE_COUNTRIES['Asia'].includes('India'));
  assert.ok(SCOPE_COUNTRIES['Southeast Asia'].includes('Vietnam'));
  assert.ok(SCOPE_COUNTRIES['South America'].includes('Brazil'));
  assert.ok(SCOPE_COUNTRIES['sub-Saharan Africa'].includes('Kenya'));
  assert.ok(!SCOPE_COUNTRIES['sub-Saharan Africa'].includes('Egypt'));
  assert.ok(!SCOPE_COUNTRIES['Asia'].includes('Brazil'));
  // Mediterranean region and Sub-Saharan Africa are pruned from SCOPE_COUNTRIES;
  // they resolve via COARSE_REGION_TO_SCOPES instead.
  assert.ok(SCOPE_COUNTRIES['Mediterranean region'] === undefined);
  assert.ok(SCOPE_COUNTRIES['Mediterranean'] === undefined);
  assert.deepEqual(COARSE_REGION_TO_SCOPES['Mediterranean region'], ['Europe','Africa','Asia']);
  assert.ok(SCOPE_COUNTRIES['Sub-Saharan Africa'] === undefined);
  assert.deepEqual(COARSE_REGION_TO_SCOPES['Sub-Saharan Africa'], ['sub-Saharan Africa']);
  assert.equal(SCOPE_COUNTRIES['Global'], undefined);
});

// scopesForCountry (the SCOPE_COUNTRIES inverse) lives only in backend/lib/region-vocab.js
// now (web re-exports data only) — it is unit-tested in backend/lib/region-vocab.test.js.
