'use strict';

/**
 * Tests for migration 038: staging_field_corrections table.
 *
 * Uses better-sqlite3 in-memory database (sync API) to match the migration's
 * own sync interface. Run directly with:
 *   node --test backend/migrations/038_staging_field_corrections.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./038_staging_field_corrections');

function freshDb() {
  const db = new Database(':memory:');
  // extraction_staging referenced via FK — create it first
  db.exec(`CREATE TABLE extraction_staging (
    id INTEGER PRIMARY KEY,
    target_table TEXT,
    source_id INTEGER,
    payload TEXT,
    review_status TEXT DEFAULT 'pending',
    reviewed_at TEXT
  )`);
  return db;
}

test('migration 038 creates staging_field_corrections table with expected columns', () => {
  const db = freshDb();
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(staging_field_corrections)').all().map(c => c.name);
  assert.ok(cols.includes('id'),               'expected id');
  assert.ok(cols.includes('staging_id'),        'expected staging_id');
  assert.ok(cols.includes('field_path'),        'expected field_path');
  assert.ok(cols.includes('action'),            'expected action');
  assert.ok(cols.includes('original_value'),    'expected original_value');
  assert.ok(cols.includes('corrected_value'),   'expected corrected_value');
  assert.ok(cols.includes('note'),              'expected note');
  assert.ok(cols.includes('reviewer_id'),       'expected reviewer_id');
  assert.ok(cols.includes('created_at'),        'expected created_at');
  db.close();
});

test('migration 038 creates expected indexes', () => {
  const db = freshDb();
  migrate(db);
  const indexes = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='staging_field_corrections'`
  ).all().map(r => r.name);
  assert.ok(indexes.includes('idx_sfc_staging'), 'expected idx_sfc_staging');
  assert.ok(indexes.includes('idx_sfc_field'),   'expected idx_sfc_field');
  db.close();
});

test('migration 038 enforces valid action CHECK constraint', () => {
  const db = freshDb();
  migrate(db);
  db.prepare(`INSERT INTO extraction_staging (id) VALUES (1)`).run();
  // valid actions should insert fine
  db.prepare(`INSERT INTO staging_field_corrections (staging_id, field_path, action) VALUES (1, 'crop', 'correct')`).run();
  db.prepare(`INSERT INTO staging_field_corrections (staging_id, field_path, action) VALUES (1, 'region', 'edited')`).run();
  db.prepare(`INSERT INTO staging_field_corrections (staging_id, field_path, action) VALUES (1, 'relation', 'rejected')`).run();
  // invalid action must throw
  assert.throws(
    () => db.prepare(`INSERT INTO staging_field_corrections (staging_id, field_path, action) VALUES (1, 'other', 'invalid')`).run(),
    /CHECK constraint failed/
  );
  db.close();
});

test('migration 038 UNIQUE(staging_id, field_path) prevents duplicate rows', () => {
  const db = freshDb();
  migrate(db);
  db.prepare(`INSERT INTO extraction_staging (id) VALUES (1)`).run();
  db.prepare(`INSERT INTO staging_field_corrections (staging_id, field_path, action) VALUES (1, 'crop', 'correct')`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO staging_field_corrections (staging_id, field_path, action) VALUES (1, 'crop', 'edited')`).run(),
    /UNIQUE constraint failed/
  );
  db.close();
});

test('migration 038 UPSERT on UNIQUE conflict works (ON CONFLICT DO UPDATE)', () => {
  const db = freshDb();
  migrate(db);
  db.prepare(`INSERT INTO extraction_staging (id) VALUES (1)`).run();
  db.prepare(`INSERT INTO staging_field_corrections (staging_id, field_path, action, corrected_value) VALUES (1, 'crop', 'correct', NULL)`).run();
  // UPSERT — should update without error
  db.prepare(`
    INSERT INTO staging_field_corrections (staging_id, field_path, action, corrected_value)
    VALUES (1, 'crop', 'edited', 'Zea mays')
    ON CONFLICT(staging_id, field_path) DO UPDATE SET
      action = excluded.action,
      corrected_value = excluded.corrected_value
  `).run();
  const row = db.prepare(`SELECT action, corrected_value FROM staging_field_corrections WHERE staging_id=1 AND field_path='crop'`).get();
  assert.equal(row.action, 'edited');
  assert.equal(row.corrected_value, 'Zea mays');
  db.close();
});

test('migration 038 is idempotent', () => {
  const db = freshDb();
  migrate(db);
  assert.doesNotThrow(() => migrate(db));
  db.close();
});
