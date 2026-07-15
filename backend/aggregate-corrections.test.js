'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m038 } = require('./migrations/038_extractor_runs_and_lessons');
const { aggregate } = require('./aggregate-corrections');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE extraction_staging (
    id INTEGER PRIMARY KEY, queue_id INTEGER, source_id INTEGER,
    target_table TEXT, payload TEXT, review_status TEXT, ai_vouch_status TEXT, created_at TEXT
  )`);
  await db.exec(`CREATE TABLE claim_critic_verdicts (
    id INTEGER PRIMARY KEY, staging_id INTEGER, critic_name TEXT,
    verdict TEXT, reasoning TEXT, model TEXT, vouched_at TEXT,
    critic_confidence REAL, evidence_strength TEXT
  )`);
  await db.exec(`CREATE TABLE extractor_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id INTEGER NOT NULL, field TEXT NOT NULL,
    original TEXT, corrected TEXT, reviewer_id TEXT, reasoning TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await m038(db);
  return db;
}

test('first correction creates a pending lesson at frequency=1', async () => {
  const db = await setup();
  await db.run(`INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id) VALUES (1, 'effect_direction', 'harmful', 'beneficial', 'r1')`);
  await aggregate(db);
  const rows = await db.all(`SELECT * FROM extractor_lessons`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].frequency, 1);
  assert.equal(rows[0].status, 'pending');
});

test('second matching correction auto-approves at frequency=2', async () => {
  const db = await setup();
  await db.run(`INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id) VALUES
    (1, 'effect_direction', 'harmful', 'beneficial', 'r1'),
    (2, 'effect_direction', 'harmful', 'beneficial', 'r2')`);
  await aggregate(db);
  const row = await db.get(`SELECT * FROM extractor_lessons`);
  assert.equal(row.frequency, 2);
  assert.equal(row.status, 'approved');
  assert.ok(row.auto_approved_at);
});

test('different patterns produce separate lessons', async () => {
  const db = await setup();
  await db.run(`INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id) VALUES
    (1, 'effect_direction', 'harmful', 'beneficial', 'r1'),
    (2, 'affected_part', 'leaves', 'roots', 'r1')`);
  await aggregate(db);
  const rows = await db.all(`SELECT field FROM extractor_lessons ORDER BY field`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.field), ['affected_part', 'effect_direction']);
});

test('rejected lessons stay rejected even at high frequency', async () => {
  const db = await setup();
  await db.run(`INSERT INTO extractor_lessons (field, original_pattern, corrected_pattern, frequency, status) VALUES ('effect_direction','harmful','beneficial', 1, 'rejected')`);
  await db.run(`INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id) VALUES
    (1, 'effect_direction', 'harmful', 'beneficial', 'r1'),
    (2, 'effect_direction', 'harmful', 'beneficial', 'r2'),
    (3, 'effect_direction', 'harmful', 'beneficial', 'r3')`);
  await aggregate(db);
  const row = await db.get(`SELECT * FROM extractor_lessons WHERE field='effect_direction'`);
  assert.equal(row.status, 'rejected', 'rejected stickiness preserved');
  assert.equal(row.frequency, 4, 'frequency still increments (so we can see the rejected pattern is still being attempted)');
});

test('graduated lessons do not get re-promoted on new corrections', async () => {
  const db = await setup();
  await db.run(`INSERT INTO extractor_lessons (field, original_pattern, corrected_pattern, frequency, status, graduated_at) VALUES ('effect_direction','harmful','beneficial', 10, 'graduated', datetime('now'))`);
  await db.run(`INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id) VALUES (1, 'effect_direction', 'harmful', 'beneficial', 'r1')`);
  await aggregate(db);
  const row = await db.get(`SELECT * FROM extractor_lessons WHERE field='effect_direction'`);
  assert.equal(row.status, 'graduated', 'graduated stays graduated');
});

test('aggregate is idempotent — running twice on same corrections does not double-count', async () => {
  const db = await setup();
  await db.run(`INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id) VALUES
    (1, 'effect_direction', 'harmful', 'beneficial', 'r1'),
    (2, 'effect_direction', 'harmful', 'beneficial', 'r2')`);
  await aggregate(db);
  await aggregate(db);  // second run should be a no-op
  const row = await db.get(`SELECT frequency FROM extractor_lessons`);
  assert.equal(row.frequency, 2);
});
