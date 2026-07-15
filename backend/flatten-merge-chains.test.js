'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { buildTerminalResolver, planFlatten, applyPlan } = require('./flatten-merge-chains');

function seed() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, merged_into_entity_id INTEGER, parent_entity_id INTEGER);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER);
    CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER);
    CREATE TABLE revision_log (id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id INTEGER,
      field TEXT, before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')));
  `);
  // Terminal canonical 8; chain 5 -> 6 -> 7 -> 8 (7 already points at terminal 8).
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (8,'term',NULL)`).run();
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (7,'hop2',8)`).run();
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (6,'hop1',7)`).run();
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (5,'loser',6)`).run();
  // stray FKs pointing at tombstones (intermediate 6 and loser 5)
  db.prepare(`INSERT INTO claims (id, subject_entity_id, object_entity_id) VALUES (100, 6, 999)`).run();
  db.prepare(`INSERT INTO entity_trait_claims (id, entity_id) VALUES (200, 5)`).run();
  return db;
}

test('terminal() resolves a multi-hop chain to the non-tombstone end', () => {
  const { terminal } = buildTerminalResolver(seed());
  assert.equal(terminal(5), 8);
  assert.equal(terminal(6), 8);
  assert.equal(terminal(7), 8);
});

test('planFlatten finds only the pointers that are not already terminal + the stray FKs', () => {
  const plan = planFlatten(seed());
  // 5 (6->8) and 6 (7->8) need flattening; 7 already points at terminal 8.
  assert.deepEqual(plan.pointerChanges.sort((a,b)=>a.id-b.id),
    [{ id: 5, before: 6, after: 8 }, { id: 6, before: 7, after: 8 }]);
  // claim 100.subject 6->8 ; trait 200.entity 5->8
  assert.deepEqual(plan.fkChanges.map(c => ({ table:c.table, col:c.col, id:c.id, before:c.before, after:c.after })).sort((a,b)=>a.id-b.id),
    [{ table:'claims', col:'subject_entity_id', id:100, before:6, after:8 },
     { table:'entity_trait_claims', col:'entity_id', id:200, before:5, after:8 }]);
});

test('applyPlan flattens, logs revisions, and is idempotent', () => {
  const db = seed();
  const n = applyPlan(db, planFlatten(db));
  assert.equal(n.pointers, 2);
  assert.equal(n.fks, 2);
  // pointers now terminal
  for (const id of [5,6,7]) assert.equal(db.prepare('SELECT merged_into_entity_id mi FROM entities WHERE id=?').get(id).mi, 8);
  // FKs re-pointed
  assert.equal(db.prepare('SELECT subject_entity_id s FROM claims WHERE id=100').get().s, 8);
  assert.equal(db.prepare('SELECT entity_id e FROM entity_trait_claims WHERE id=200').get().e, 8);
  // revision_log has 4 rows (2 pointer + 2 fk)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM revision_log WHERE method LIKE 'flatten_merge_chain%'`).get().n, 4);
  // idempotent: a second plan is empty
  const plan2 = planFlatten(db);
  assert.equal(plan2.pointerChanges.length, 0);
  assert.equal(plan2.fkChanges.length, 0);
});

test('buildTerminalResolver throws on a cycle', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, merged_into_entity_id INTEGER, parent_entity_id INTEGER)`);
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (9,'a',10),(10,'b',9)`).run();
  const { terminal } = buildTerminalResolver(db);
  assert.throws(() => terminal(9), /cycle/i);
});
