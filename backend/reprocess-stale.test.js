'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m038 } = require('./migrations/038_extractor_runs_and_lessons');
const { classifyAll } = require('./reprocess-stale');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT)`);
  await db.exec(`CREATE TABLE extraction_staging (id INTEGER PRIMARY KEY, queue_id INTEGER, source_id INTEGER, target_table TEXT, payload TEXT, review_status TEXT, ai_vouch_status TEXT, created_at TEXT)`);
  await db.exec(`CREATE TABLE claim_critic_verdicts (id INTEGER PRIMARY KEY, staging_id INTEGER, critic_name TEXT, verdict TEXT, reasoning TEXT, model TEXT, vouched_at TEXT, critic_confidence REAL, evidence_strength TEXT)`);
  await m038(db);
  await db.run(`INSERT INTO sources (id, title) VALUES (1, 'Test'), (2, 'Other')`);
  await db.run(`INSERT INTO extractor_runs (id, source_id, extractor_md_sha, prompt_bundle_sha, extraction_model, status) VALUES
    (10, 1, 'AA', 'BB', 'm', 'complete'),
    (11, 1, 'CC', 'BB', 'm', 'complete'),
    (12, 2, 'AA', 'XX', 'm', 'complete'),
    (13, 2, 'legacy', 'legacy', 'm', 'complete')`);
  return db;
}

test('classifyAll returns counts per category', async () => {
  const db = await setup();
  const report = await classifyAll(db, { extractor_md: 'AA', bundle: 'BB' });
  assert.equal(report.up_to_date.length, 1);          // run 10
  assert.equal(report.re_extract_needed.length, 2);    // runs 11, 13
  assert.equal(report.re_vouch_only.length, 1);        // run 12
});
