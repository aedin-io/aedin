'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { findLocalitylessClaims } = require('./drop-localityless-claims');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE claims (
    id INTEGER PRIMARY KEY, review_status TEXT, regional_context TEXT, source_quote TEXT);`);
  const ins = db.prepare('INSERT INTO claims (id, review_status, regional_context, source_quote) VALUES (?,?,?,?)');
  ins.run(1, 'ai_reviewed', 'India', 'q1');
  ins.run(2, 'ai_reviewed', 'Global', 'q2');
  ins.run(3, 'ai_reviewed', 'United States, Australia', 'q3');
  ins.run(4, 'ai_reviewed', '', 'q4');
  ins.run(5, 'ai_reviewed', 'Grenada', 'q5');
  ins.run(6, 'tier2_globi', '', 'q6');
  return db;
}

test('findLocalitylessClaims returns only unresolvable ai_reviewed claims', () => {
  const db = fixture();
  const rows = findLocalitylessClaims(db);
  assert.deepEqual(rows.map(r => r.id).sort(), [4, 5]);
  db.close();
});
