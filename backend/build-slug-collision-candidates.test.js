'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m045 } = require('./migrations/045_entity_dedup_candidates');
const { buildSlugCandidates } = require('./build-slug-collision-candidates');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY, scientific_name TEXT, slug TEXT, scope_tier INTEGER,
    needs_dedup INTEGER DEFAULT 0, merged_into_entity_id INTEGER, gbif_key TEXT,
    grin_accession TEXT, parent_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await m045(db);
  // In-worklist pair: both flagged, both slugless, same base slug.
  await db.run(`INSERT INTO entities (id, scientific_name, slug, scope_tier, needs_dedup) VALUES
    (10,'Citrus limon',NULL,0,1), (11,'Citrus × limon',NULL,3,1)`);
  // Orphan singleton: flagged row whose base slug matches an already-slugged, non-flagged twin.
  await db.run(`INSERT INTO entities (id, scientific_name, slug, scope_tier, needs_dedup) VALUES
    (20,"Solanum lycopersicum 'NC 2y'",NULL,0,1),
    (21,"Solanum lycopersicum 'NC 2y'",'solanum-lycopersicum-nc-2y',0,0)`);
  // No-twin flagged row: no same-base-slug partner anywhere.
  await db.run(`INSERT INTO entities (id, scientific_name, slug, scope_tier, needs_dedup) VALUES
    (30,'Apis melliferae',NULL,NULL,1)`);
  return db;
}

test('buildSlugCandidates pairs in-worklist + orphan, reports no-twin, idempotent', async () => {
  const db = await setup();
  const dry = await buildSlugCandidates(db, { apply: false });
  assert.deepEqual(dry.inWorklistPairs, [{ a: 10, b: 11 }]);
  assert.deepEqual(dry.orphansPaired, [{ flagged: 20, twin: 21 }]);
  assert.deepEqual(dry.noTwin.map(x => x.id), [30]);
  assert.equal((await db.get(`SELECT COUNT(*) n FROM entity_dedup_candidates`)).n, 0, 'dry-run writes nothing');

  await buildSlugCandidates(db, { apply: true });
  const rows = await db.all(`SELECT entity_a_id, entity_b_id, match_basis FROM entity_dedup_candidates ORDER BY entity_a_id`);
  assert.deepEqual(rows, [
    { entity_a_id: 10, entity_b_id: 11, match_basis: 'slug_collision' },
    { entity_a_id: 20, entity_b_id: 21, match_basis: 'slug_collision' },
  ]);
  await buildSlugCandidates(db, { apply: true }); // idempotent
  assert.equal((await db.get(`SELECT COUNT(*) n FROM entity_dedup_candidates`)).n, 2);
});
