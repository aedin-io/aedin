// web/src/lib/merge-listing-filter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getVarietiesForSpecies } from './queries-d1.ts';

function d1(db) {
  return { prepare(sql) { const stmt = db.prepare(sql); let args = [];
    const api = { bind(...a){ args = a; return api; },
      async all(){ return { results: stmt.all(...args), success: true }; },
      async first(){ return stmt.get(...args) ?? null; } }; return api; } };
}

function seed() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scientific_name TEXT,
    common_name TEXT, variety_name TEXT, variety_type TEXT, grin_accession TEXT,
    parent_entity_id INTEGER, scope_tier INTEGER, merged_into_entity_id INTEGER);`);
  // parent species 1; two served varieties under it — one live (10), one tombstoned (11)
  db.prepare(`INSERT INTO entities (id, slug, variety_name, variety_type, parent_entity_id, scope_tier) VALUES (10,'sp-good','Good','cultivar',1,0)`).run();
  db.prepare(`INSERT INTO entities (id, slug, variety_name, variety_type, parent_entity_id, scope_tier, merged_into_entity_id) VALUES (11,'sp-dup','Dup','cultivar',1,0,10)`).run();
  return db;
}

test('getVarietiesForSpecies excludes a tombstoned variety', async () => {
  const rows = await getVarietiesForSpecies(d1(seed()), 1);
  const slugs = rows.map(r => r.slug);
  assert.ok(slugs.includes('sp-good'), 'live variety present');
  assert.ok(!slugs.includes('sp-dup'), 'tombstoned variety excluded');
});
