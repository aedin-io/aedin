'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./048_globi_citation_columns');

function freshDb() {
  const db = new Database(':memory:');
  // Minimal claims table mirroring the real one's relevant column.
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, reference_citation TEXT)`);
  return db;
}

test('migration 048 adds reference_doi, reference_url, source_count to claims', () => {
  const db = freshDb();
  migrate(db);
  const cols = db.prepare(`PRAGMA table_info(claims)`).all().map((c) => c.name);
  for (const c of ['reference_doi', 'reference_url', 'source_count']) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
  db.close();
});

test('migration 048 is idempotent', () => {
  const db = freshDb();
  migrate(db);
  migrate(db); // must not throw on duplicate ADD COLUMN
  db.close();
});
