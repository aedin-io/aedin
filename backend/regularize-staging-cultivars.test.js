'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { regularizeOne } = require('./regularize-staging-cultivars.js');

function db0() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, variety_name TEXT,
    parent_entity_id INTEGER, source_table TEXT, scope_tier INTEGER, needs_dedup INTEGER DEFAULT 0, variety_type TEXT)`);
  db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT,
    before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')))`);
  // species parent + a genus parent
  db.prepare("INSERT INTO entities (id,scientific_name) VALUES (100,'Capsicum annuum')").run();
  db.prepare("INSERT INTO entities (id,scientific_name) VALUES (200,'Musa spp.')").run();
  return db;
}
const cultivar = (db, id, parent, name) => db.prepare(
  "INSERT INTO entities (id,scientific_name,variety_name,parent_entity_id,source_table,needs_dedup,variety_type) VALUES (?,?,?,?,'extraction_staging',1,'cultivar')"
).run(id, `x '${name}'`, name, parent);

test('dissimilar cultivar under species parent -> served (scope_tier set, needs_dedup cleared)', () => {
  const db = db0();
  cultivar(db, 10, 100, 'Yolo Wonder');
  const r = regularizeOne(db, db.prepare('SELECT * FROM entities WHERE id=10').get());
  assert.equal(r.action, 'served');
  const e = db.prepare('SELECT scope_tier, needs_dedup FROM entities WHERE id=10').get();
  assert.equal(e.scope_tier, 0);
  assert.equal(e.needs_dedup, 0);
  db.close();
});

test('genus-only parent (Musa spp.) -> held back, not served', () => {
  const db = db0();
  cultivar(db, 11, 200, 'Fiji');
  const r = regularizeOne(db, db.prepare('SELECT * FROM entities WHERE id=11').get());
  assert.equal(r.action, 'hold');
  assert.equal(r.reason, 'genus_parent');
  assert.equal(db.prepare('SELECT scope_tier FROM entities WHERE id=11').get().scope_tier, null);
  db.close();
});

test('near-dup sibling -> kept needs_dedup=1 but still served', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id,scientific_name,variety_name,parent_entity_id) VALUES (5,'x','Yolo Wonder',100)").run(); // sibling
  cultivar(db, 12, 100, 'Yolo Wonde'); // dist 1 -> near-dup
  const r = regularizeOne(db, db.prepare('SELECT * FROM entities WHERE id=12').get());
  assert.equal(r.action, 'served');
  assert.equal(db.prepare('SELECT needs_dedup FROM entities WHERE id=12').get().needs_dedup, 1);
  db.close();
});

test('exact sibling match -> dup, not served', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id,scientific_name,variety_name,parent_entity_id) VALUES (5,'x','Yolo Wonder',100)").run();
  cultivar(db, 13, 100, 'Yolo Wonder');
  const r = regularizeOne(db, db.prepare('SELECT * FROM entities WHERE id=13').get());
  assert.equal(r.action, 'dup');
  assert.equal(db.prepare('SELECT scope_tier FROM entities WHERE id=13').get().scope_tier, null);
  db.close();
});

test('idempotent: second pass on a served row makes no revision_log rows', () => {
  const db = db0();
  cultivar(db, 10, 100, 'Yolo Wonder');
  regularizeOne(db, db.prepare('SELECT * FROM entities WHERE id=10').get());
  const before = db.prepare('SELECT COUNT(*) n FROM revision_log').get().n;
  regularizeOne(db, db.prepare('SELECT * FROM entities WHERE id=10').get());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revision_log').get().n, before);
  db.close();
});
