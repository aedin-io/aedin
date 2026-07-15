'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m025 } = require('./025_claim_critic_verdicts');
const { runMigration } = require('./036_critic_verdict_confidence');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE extraction_staging (id INTEGER PRIMARY KEY, target_table TEXT, source_id INTEGER)`);
  await m025(db);
  return db;
}

test('migration 036 adds critic_confidence + evidence_strength columns', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(claim_critic_verdicts)`)).map(c => c.name);
  assert.ok(cols.includes('critic_confidence'));
  assert.ok(cols.includes('evidence_strength'));
});

test('migration 036 creates v_review_priority view', async () => {
  const db = await freshDb();
  await runMigration(db);
  const view = await db.get(
    `SELECT name FROM sqlite_master WHERE type='view' AND name='v_review_priority'`);
  assert.ok(view, 'v_review_priority view should exist');
});

test('v_review_priority returns priority bands across canonical patterns', async () => {
  const db = await freshDb();
  await runMigration(db);
  // Seed staging rows + verdict patterns
  for (let i = 1; i <= 4; i++) {
    await db.run(`INSERT INTO extraction_staging (id, target_table, source_id) VALUES (?, 'interactions', 1)`, [i]);
  }
  // Disputed: row 1
  await db.run(`INSERT INTO claim_critic_verdicts (staging_id, critic_name, verdict, critic_confidence, evidence_strength) VALUES (1,'agroecologist','plausible',0.9,'strong'),(1,'entomologist','implausible',0.8,'moderate')`);
  // High-confidence consensus: row 2
  await db.run(`INSERT INTO claim_critic_verdicts (staging_id, critic_name, verdict, critic_confidence, evidence_strength) VALUES (2,'agroecologist','plausible',0.92,'strong'),(2,'entomologist','plausible',0.88,'strong')`);
  // Low-confidence consensus: row 3
  await db.run(`INSERT INTO claim_critic_verdicts (staging_id, critic_name, verdict, critic_confidence, evidence_strength) VALUES (3,'agroecologist','plausible',0.4,'moderate'),(3,'entomologist','plausible',0.3,'moderate')`);
  // Weak evidence: row 4
  await db.run(`INSERT INTO claim_critic_verdicts (staging_id, critic_name, verdict, critic_confidence, evidence_strength) VALUES (4,'agroecologist','plausible',0.7,'weak'),(4,'entomologist','plausible',0.7,'weak')`);
  const rows = await db.all(`SELECT staging_id, priority_score FROM v_review_priority ORDER BY staging_id`);
  assert.equal(rows.find(r => r.staging_id === 1).priority_score, 100);
  assert.equal(rows.find(r => r.staging_id === 2).priority_score, 10);
  assert.equal(rows.find(r => r.staging_id === 3).priority_score, 60);
  assert.equal(rows.find(r => r.staging_id === 4).priority_score, 40);
});

test('migration 036 is idempotent', async () => {
  const db = await freshDb();
  await runMigration(db);
  await runMigration(db);
});
