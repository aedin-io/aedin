'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { TRIPLES_SQL } = require('./load-globi-claims');

// Build an in-memory interactions fixture: one triple, 3 records, 2 distinct
// citations. interaction_locality_coverage is present but empty (country='').
function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE interactions (
    source_name TEXT, source_path TEXT, target_name TEXT, target_path TEXT,
    interaction_type TEXT, lat REAL, lng REAL, location TEXT,
    reference_citation TEXT, reference_doi TEXT, reference_url TEXT, source_citation TEXT)`);
  db.exec(`CREATE TABLE interaction_locality_coverage (
    source_name TEXT, target_name TEXT, country TEXT, subdivision TEXT)`);
  const ins = db.prepare(`INSERT INTO interactions
    (source_name, target_name, interaction_type, location, reference_citation, reference_doi, reference_url)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run('Apis mellifera', 'Zea mays', 'visitsFlowersOf', 'IL', 'Smith 1999', '10.1/a', 'https://x/a');
  ins.run('Apis mellifera', 'Zea mays', 'visitsFlowersOf', 'IA', 'Smith 1999', '10.1/a', 'https://x/a');
  ins.run('Apis mellifera', 'Zea mays', 'visitsFlowersOf', 'WI', 'Jones 2005', '10.2/b', 'https://x/b');
  return db;
}

test('TRIPLES_SQL aggregates count + a representative rowid (citation fetched via rowid JOIN, not in the sort)', () => {
  const db = fixtureDb();
  const rows = db.prepare(TRIPLES_SQL).all();
  assert.equal(rows.length, 1, 'one deduplicated triple');
  const r = rows[0];
  assert.equal(r.cnt, 3);
  // The GROUP BY carries only the integer rep_rowid (keeps the sort light at
  // 27.5M-row scale); MAX(rowid) is the last-inserted record.
  assert.equal(r.rep_rowid, 3);
  // Citations are looked up from interactions by rep_rowid at processing time
  // (what load does via the batch JOIN) — verify that lookup is correct.
  const cit = db.prepare(
    'SELECT reference_citation, reference_doi, reference_url FROM interactions WHERE rowid = ?'
  ).get(r.rep_rowid);
  assert.equal(cit.reference_citation, 'Jones 2005');
  assert.equal(cit.reference_doi, '10.2/b');
  assert.equal(cit.reference_url, 'https://x/b');
  db.close();
});
