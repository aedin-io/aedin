'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m045 } = require('./migrations/045_entity_dedup_candidates');
const { runMigration: m064 } = require('./migrations/064_entity_dedup_tier');
const { runMigration: m066 } = require('./migrations/066_entity_dedup_verdicts');
const { prepareBatches } = require('./dedup-review-batch-prepare');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, bio_category TEXT,
    taxonomy_path TEXT, gbif_key TEXT, merged_into_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await m045(db); await m064(db); await m066(db);
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category) VALUES
    (1,'Bombus terrestris','invertebrate'), (2,'Bombus terestris','invertebrate'),
    (3,'Citrus limon','plantae'), (4,'Citrus limonn','plantae')`);
  await db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id, tier, status) VALUES
    (1,2,'Bombus',1,'species_epithet',1,'auto_safe','pending'),
    (3,4,'Citrus',1,'species_epithet',3,'needs_review','pending')`);
  return db;
}

test('prepareBatches selects pending, routes, writes batch JSON; skips already-verdicted (resumable)', async () => {
  const db = await setup();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-batch-'));
  const r = await prepareBatches(db, { batchSize: 12, maxRows: 999, tier: null, outDir });
  assert.equal(r.pairs, 2);
  const files = fs.readdirSync(outDir).filter(f => f.startsWith('batch-'));
  assert.equal(files.length, 1);
  const batch = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
  assert.equal(batch.pairs.length, 2);
  assert.ok(batch.pairs.some(p => p.critic === 'entomologist' && p.body.includes('Bombus')));
  assert.ok(batch.pairs.some(p => p.critic === 'horticulturist' && p.body.includes('Citrus')));

  // resumable: a candidate with a verdict already is skipped
  const candId = (await db.get(`SELECT id FROM entity_dedup_candidates WHERE entity_a_id=1`)).id;
  await db.run(`INSERT INTO entity_dedup_verdicts (candidate_id, critic_name, verdict) VALUES (?, 'entomologist', 'same')`, candId);
  const r2 = await prepareBatches(db, { batchSize: 12, maxRows: 999, tier: null, outDir });
  assert.equal(r2.pairs, 1); // only the Citrus pair remains
});

test('prepareBatches --tier filter narrows selection', async () => {
  const db = await setup();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-batch-'));
  const r = await prepareBatches(db, { batchSize: 12, maxRows: 999, tier: 'auto_safe', outDir });
  assert.equal(r.pairs, 1); // only the auto_safe Bombus pair
});
