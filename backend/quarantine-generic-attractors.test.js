'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { quarantineClaim, AUTO_IDS, BOUNDARY_IDS } = require('./quarantine-generic-attractors.js');

function db0() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, interaction_category TEXT, review_status TEXT)`);
  db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT,
    before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

test('AUTO_IDS has 19 ids and BOUNDARY_IDS has 3, disjoint', () => {
  assert.equal(AUTO_IDS.length, 19);
  assert.equal(BOUNDARY_IDS.length, 3);
  assert.equal(AUTO_IDS.filter(x => BOUNDARY_IDS.includes(x)).length, 0);
});

test('quarantineClaim sets review_status + logs a revision', () => {
  const db = db0();
  db.prepare(`INSERT INTO claims (id, interaction_category, review_status) VALUES (6496213,'nectar_provision','ai_reviewed')`).run();
  const r = quarantineClaim(db, 6496213);
  assert.equal(r.changed, true);
  assert.equal(db.prepare('SELECT review_status FROM claims WHERE id=6496213').get().review_status, 'quarantined_generic');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revision_log WHERE target_id=6496213 AND field='review_status'").get().n, 1);
});

test('quarantineClaim is idempotent and skips absent claims', () => {
  const db = db0();
  db.prepare(`INSERT INTO claims (id, interaction_category, review_status) VALUES (6496213,'nectar_provision','quarantined_generic')`).run();
  assert.equal(quarantineClaim(db, 6496213).changed, false);   // already done
  assert.equal(quarantineClaim(db, 99999999).changed, false);  // absent
});
