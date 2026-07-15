// backend/dedup-review-batch-import.test.js
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
const { runMigration: m065 } = require('./migrations/065_entity_dedup_log');
const { runMigration: m066 } = require('./migrations/066_entity_dedup_verdicts');
const { importVerdicts } = require('./dedup-review-batch-import');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, merged_into_entity_id INTEGER, parent_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id INTEGER, field TEXT, before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')))`);
  await m045(db); await m064(db); await m065(db); await m066(db);
  await db.run(`INSERT INTO entities (id, scientific_name) VALUES (10,'Acer saccharinum'),(11,'Acer saccarinum'),(20,'Rubus microphyllus'),(21,'Rubus macrophyllus'),(30,'Galium x'),(31,'Galium y'),(40,'Foo a'),(41,'Foo b')`);
  await db.run(`INSERT INTO claims (id, subject_entity_id, object_entity_id) VALUES (1, 11, 999)`);
  await db.run(`INSERT INTO entity_dedup_candidates (id, entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id, tier, status) VALUES
    (100,10,11,'Acer',1,'species_epithet',10,'auto_safe','pending'),
    (101,20,21,'Rubus',1,'species_epithet',20,'auto_safe','pending'),
    (102,30,31,'Galium',1,'species_epithet',30,'needs_review','pending'),
    (103,40,41,'Foo',1,'species_epithet',40,'auto_safe','pending')`);
  return db;
}

function writeVerdicts(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'batch-000.json'), JSON.stringify(rows, null, 2));
}

test('gate: same+high → merge; distinct → reject; uncertain/low → stay pending; malformed skipped', async () => {
  const db = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-verd-'));
  writeVerdicts(dir, [
    { candidate_id: 100, critic: 'horticulturist', verdict: 'same', confidence: 0.95, suggested_canonical_id: null, reasoning: 'typo' },
    { candidate_id: 101, critic: 'horticulturist', verdict: 'distinct', confidence: 0.9, reasoning: 'micro vs macro' },
    { candidate_id: 102, critic: 'horticulturist', verdict: 'uncertain', confidence: 0.5, reasoning: 'unclear' },
    { candidate_id: 103, critic: 'horticulturist', verdict: 'same', confidence: 0.6, reasoning: 'maybe' },
    { critic: 'horticulturist', verdict: 'same' }, // malformed (no candidate_id)
  ]);
  const r = await importVerdicts(db, { verdictsDir: dir, confThreshold: 0.8 });
  assert.equal(r.merged, 1);
  assert.equal(r.rejected, 1);
  assert.equal(r.escalated, 2);   // uncertain + low-conf same
  assert.equal(r.malformed, 1);
  // 100 merged
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE id=100`)).status, 'merged');
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=11`)).merged_into_entity_id, 10);
  assert.equal((await db.get(`SELECT subject_entity_id FROM claims WHERE id=1`)).subject_entity_id, 10);
  assert.ok((await db.get(`SELECT id FROM revision_log WHERE target_id=11`)));
  // 101 rejected, not merged
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE id=101`)).status, 'rejected');
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=21`)).merged_into_entity_id, null);
  // 102 + 103 stay pending
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE id=102`)).status, 'pending');
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE id=103`)).status, 'pending');
});

test('critic-corrected canonical is applied before merge', async () => {
  const db = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-verd-'));
  // candidate 100 suggests canonical 10; critic overrides to 11
  writeVerdicts(dir, [{ candidate_id: 100, critic: 'horticulturist', verdict: 'same', confidence: 0.9, suggested_canonical_id: 11, reasoning: 'keep 11' }]);
  await importVerdicts(db, { verdictsDir: dir, confThreshold: 0.8 });
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=10`)).merged_into_entity_id, 11);
});
