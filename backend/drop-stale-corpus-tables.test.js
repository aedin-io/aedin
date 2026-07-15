'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { corpusTablesToDrop, guardOk, dropStaleTables } = require('./drop-stale-corpus-tables.js');

function raw() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE interactions (id INTEGER)`);            // raw — keep
  db.exec(`CREATE TABLE claims (id INTEGER)`);                  // corpus — drop candidate
  db.exec(`INSERT INTO claims (id) VALUES (1),(2)`);
  return db;
}

test('corpusTablesToDrop excludes the 6 raw tables', () => {
  const db = raw();
  assert.deepEqual(corpusTablesToDrop(db), ['claims']);
  db.close();
});

test('guardOk passes when corpus is at-or-ahead', () => {
  const r = raw();
  const c = new Database(':memory:');
  c.exec(`CREATE TABLE claims (id INTEGER)`);
  c.exec(`INSERT INTO claims (id) VALUES (1),(2),(3)`);          // 3 >= 2
  assert.deepEqual(guardOk(c, r, ['claims']), { ok: true, blockers: [] });
  r.close(); c.close();
});

test('guardOk blocks when corpus is missing or short', () => {
  const r = raw();
  const c = new Database(':memory:');
  c.exec(`CREATE TABLE claims (id INTEGER)`);
  c.exec(`INSERT INTO claims (id) VALUES (1)`);                  // 1 < 2 → short
  const res = guardOk(c, r, ['claims']);
  assert.equal(res.ok, false);
  assert.match(res.blockers[0], /claims/);
  r.close(); c.close();
});

test('guardOk blocks when table is missing from corpus entirely', () => {
  const r = raw();
  const c = new Database(':memory:');                            // corpus has no claims table
  const res = guardOk(c, r, ['claims']);
  assert.equal(res.ok, false);
  assert.match(res.blockers[0], /missing from corpus/);
  r.close(); c.close();
});

test('dropStaleTables drops FK-referenced parents despite default FK enforcement', () => {
  // Reproduces the live failure: better-sqlite3 enables foreign_keys by default,
  // so dropping a parent (entities) still referenced by a child (claims) throws
  // SQLITE_CONSTRAINT_FOREIGNKEY unless enforcement is disabled for the teardown.
  const db = new Database(':memory:');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'FK on by default');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY)`);      // parent
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY,
    subject_entity_id INTEGER REFERENCES entities(id))`);        // child FK -> entities
  db.exec(`INSERT INTO entities (id) VALUES (1)`);
  db.exec(`INSERT INTO claims (id, subject_entity_id) VALUES (1, 1)`);

  // A naive drop of the parent first WOULD throw with FK on:
  assert.throws(() => db.exec(`DROP TABLE entities`), /FOREIGN KEY|foreign key|SQLITE_CONSTRAINT/i);

  // dropStaleTables disables FK enforcement, so both drop cleanly in any order:
  dropStaleTables(db, ['entities', 'claims']);
  const remaining = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map(r => r.name);
  assert.deepEqual(remaining, []);
  db.close();
});
