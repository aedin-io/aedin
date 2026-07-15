'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./033_traits_vocabulary');
const SEED = require('./033_traits_vocabulary.seed');

async function freshDb() {
  return await open({ filename: ':memory:', driver: sqlite3.Database });
}

test('migration 033 creates traits_vocabulary table', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = await db.all(`PRAGMA table_info(traits_vocabulary)`);
  const names = cols.map(c => c.name);
  for (const required of [
    'trait_name', 'value_kind', 'expected_unit',
    'applicable_bio_categories', 'enum_values',
    'description', 'upstream_mappings', 'introduced_at',
  ]) {
    assert.ok(names.includes(required), `missing column: ${required}`);
  }
});

test('migration 033 seeds the vocabulary', async () => {
  const db = await freshDb();
  await runMigration(db);
  const rows = await db.all(`SELECT trait_name, value_kind FROM traits_vocabulary`);
  assert.ok(rows.length >= 30, `expected ≥30 seed traits, got ${rows.length}`);
  // spot-check several entries
  const byName = Object.fromEntries(rows.map(r => [r.trait_name, r.value_kind]));
  assert.equal(byName.thermal_min, 'numeric');
  assert.equal(byName.voltinism, 'categorical');
  assert.equal(byName.host_range, 'list');
  assert.equal(byName.seed_borne, 'boolean');
  assert.equal(byName.favorable_humidity, 'range');
});

test('migration 033 seed is idempotent (re-run does not duplicate)', async () => {
  const db = await freshDb();
  await runMigration(db);
  const before = (await db.get(`SELECT COUNT(*) c FROM traits_vocabulary`)).c;
  await runMigration(db);
  const after = (await db.get(`SELECT COUNT(*) c FROM traits_vocabulary`)).c;
  assert.equal(before, after);
});

test('seed module exports plain array', () => {
  assert.ok(Array.isArray(SEED), 'seed must be array');
  assert.ok(SEED.length >= 30);
  for (const row of SEED) {
    assert.ok(row.trait_name, 'every seed row needs trait_name');
    assert.ok(['numeric', 'categorical', 'range', 'list', 'boolean'].includes(row.value_kind),
      `bad value_kind for ${row.trait_name}: ${row.value_kind}`);
    assert.ok(Array.isArray(row.applicable_bio_categories),
      `applicable_bio_categories for ${row.trait_name} must be array`);
  }
});
