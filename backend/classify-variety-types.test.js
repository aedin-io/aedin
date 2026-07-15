'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { classifyOne } = require('./classify-variety-types.js');

function db0() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, variety_name TEXT,
    parent_entity_id INTEGER, variety_type TEXT)`);
  db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT,
    before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

test('classifyOne writes variety_type + logs the change; idempotent', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id,scientific_name,parent_entity_id) VALUES (1,'Prunus persica ''Gulfking''',5)").run();
  const t = classifyOne(db, db.prepare('SELECT * FROM entities WHERE id=1').get());
  assert.equal(t, 'cultivar');
  assert.equal(db.prepare('SELECT variety_type FROM entities WHERE id=1').get().variety_type, 'cultivar');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revision_log WHERE field='variety_type'").get().n, 1);
  // second pass: no new revision_log row (already classified)
  classifyOne(db, db.prepare('SELECT * FROM entities WHERE id=1').get());
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revision_log WHERE field='variety_type'").get().n, 1);
  db.close();
});
