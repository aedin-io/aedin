'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./038_extractor_runs_and_lessons');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT)`);
  await db.exec(`CREATE TABLE extraction_staging (
    id INTEGER PRIMARY KEY, queue_id INTEGER, source_id INTEGER,
    target_table TEXT, payload TEXT, review_status TEXT, ai_vouch_status TEXT, created_at TEXT
  )`);
  await db.exec(`CREATE TABLE claim_critic_verdicts (
    id INTEGER PRIMARY KEY, staging_id INTEGER, critic_name TEXT,
    verdict TEXT, reasoning TEXT, model TEXT, vouched_at TEXT,
    critic_confidence REAL, evidence_strength TEXT
  )`);
  return db;
}

test('migration 038 creates extractor_runs table with required columns', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(extractor_runs)`)).map(c => c.name);
  for (const c of ['id','source_id','extractor_md_sha','prompt_bundle_sha','extraction_model','started_at','completed_at','status','rows_staged','notes']) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
});

test('migration 038 creates extractor_lessons table with all required columns including graduated_at', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(extractor_lessons)`)).map(c => c.name);
  for (const c of ['id','field','original_pattern','corrected_pattern','frequency','last_seen_at','status','graduated_at','auto_approved_at','reviewer_override_at','reviewer_override_by','notes']) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
});

test('migration 038 adds run_id to extraction_staging', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(extraction_staging)`)).map(c => c.name);
  assert.ok(cols.includes('run_id'));
});

test('migration 038 adds critic_prompt_sha to claim_critic_verdicts', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(claim_critic_verdicts)`)).map(c => c.name);
  assert.ok(cols.includes('critic_prompt_sha'));
});

test('migration 038 enforces extractor_runs.status CHECK', async () => {
  const db = await freshDb();
  await runMigration(db);
  await db.run(`INSERT INTO sources (id, title) VALUES (1, 'Test')`);
  await assert.rejects(
    db.run(`INSERT INTO extractor_runs (source_id, extractor_md_sha, prompt_bundle_sha, extraction_model, status) VALUES (1, 'aa', 'bb', 'cc', 'bogus')`),
    /CHECK/
  );
});

test('migration 038 enforces extractor_lessons.status CHECK incl. graduated', async () => {
  const db = await freshDb();
  await runMigration(db);
  await db.run(`INSERT INTO extractor_lessons (field, corrected_pattern, status) VALUES ('foo','bar','graduated')`);
  await assert.rejects(
    db.run(`INSERT INTO extractor_lessons (field, corrected_pattern, status) VALUES ('foo','bar','bogus')`),
    /CHECK/
  );
});

test('migration 038 enforces UNIQUE on lesson (field, original, corrected)', async () => {
  const db = await freshDb();
  await runMigration(db);
  await db.run(`INSERT INTO extractor_lessons (field, original_pattern, corrected_pattern) VALUES ('foo','x','y')`);
  await assert.rejects(
    db.run(`INSERT INTO extractor_lessons (field, original_pattern, corrected_pattern) VALUES ('foo','x','y')`),
    /UNIQUE/
  );
});

test('migration 038 is idempotent', async () => {
  const db = await freshDb();
  await runMigration(db);
  await runMigration(db);
});
