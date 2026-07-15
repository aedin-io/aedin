'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { selectGateless, cropParentIds, summary, reconcile } = require('./grin-reconcile');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY,
      scientific_name TEXT, variety_name TEXT,
      parent_entity_id INTEGER REFERENCES entities(id),
      bio_category TEXT, primary_role TEXT,
      source_table TEXT, scope_tier INTEGER,
      variety_type TEXT, grin_accession TEXT, grin_synced_at TEXT, native_regions TEXT
    );
    CREATE TABLE revision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT, target_id INTEGER, field TEXT,
      before_value TEXT, after_value TEXT, changed_by TEXT,
      method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE entity_trait_claims (
      id INTEGER PRIMARY KEY, entity_id INTEGER REFERENCES entities(id), trait_name TEXT
    );
  `);
  // parents: 1 = okra (crop, synced), 2 = fir (weed, synced)
  db.prepare("INSERT INTO entities (id,scientific_name,primary_role,source_table,grin_synced_at) VALUES (1,'Abelmoschus esculentus','crop','globi','2026-01-01')").run();
  db.prepare("INSERT INTO entities (id,scientific_name,primary_role,source_table,grin_synced_at) VALUES (2,'Abies concolor','weed','globi','2026-01-01')").run();
  // gate-less grin varieties: 10/11 okra (crop parent), 12 fir (weed parent)
  db.prepare("INSERT INTO entities (id,scientific_name,variety_name,parent_entity_id,source_table,variety_type,grin_accession,native_regions) VALUES (10,'x','Okra1',1,'grin',NULL,'PI 1','[\"Nepal\"]')").run();
  db.prepare("INSERT INTO entities (id,scientific_name,variety_name,parent_entity_id,source_table,variety_type,grin_accession) VALUES (11,'x','Okra2',1,'grin',NULL,'PI 2')").run();
  db.prepare("INSERT INTO entities (id,scientific_name,variety_name,parent_entity_id,source_table,variety_type,grin_accession) VALUES (12,'x','Fir1',2,'grin',NULL,'PI 3')").run();
  // survivors: 13 = GATED grin (variety_type set), 14 = non-grin
  db.prepare("INSERT INTO entities (id,scientific_name,variety_name,parent_entity_id,source_table,variety_type,scope_tier,grin_accession) VALUES (13,'x','Clemson',1,'grin','cultivar',0,'PI 4')").run();
  db.prepare("INSERT INTO entities (id,scientific_name,parent_entity_id,source_table,variety_type) VALUES (14,'globi var',1,'globi',NULL)").run();
  return db;
}

test('selectGateless returns only the 3 gate-less grin rows, with parent role', () => {
  const db = makeDb();
  const rows = selectGateless(db);
  assert.deepEqual(rows.map(r => r.id), [10, 11, 12]);
  assert.equal(rows.find(r => r.id === 10).parent_role, 'crop');
  assert.equal(rows.find(r => r.id === 12).parent_role, 'weed');
});

test('cropParentIds = crop-tagged parents of the gate-less set only', () => {
  assert.deepEqual(cropParentIds(makeDb()), [1]);
});

test('summary splits crop vs non-crop and finds no references on a clean db', () => {
  const s = summary(makeDb());
  assert.equal(s.total, 3);
  assert.equal(s.crop, 2);
  assert.equal(s.nonCrop, 1);
  assert.deepEqual(s.cropParents, [1]);
  assert.deepEqual(s.references, []);
});

test('reconcile deletes gate-less grin, preserves gated grin + non-grin, clears crop-parent sync only', () => {
  const db = makeDb();
  const res = reconcile(db, { changedBy: 'reconcile-grin-gateless' });
  assert.equal(res.deleted, 3);
  assert.equal(res.cropParentsCleared, 1);
  assert.deepEqual(db.prepare('SELECT id FROM entities ORDER BY id').all().map(r => r.id), [1, 2, 13, 14]);
  assert.equal(db.prepare('SELECT grin_synced_at FROM entities WHERE id=1').get().grin_synced_at, null);
  assert.equal(db.prepare('SELECT grin_synced_at FROM entities WHERE id=2').get().grin_synced_at, '2026-01-01');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revision_log WHERE method='reconcile-grin-gateless'").get().n, 3);
});

test('reconcile aborts (throws) when a gate-less row is referenced, deleting nothing', () => {
  const db = makeDb();
  db.prepare('INSERT INTO entity_trait_claims (entity_id, trait_name) VALUES (10, ?)').run('ph_min');
  assert.throws(() => reconcile(db, { changedBy: 'reconcile-grin-gateless' }), /referenced/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entities WHERE id=10').get().n, 1);
});

test('reconcile is idempotent — second run deletes 0, logs nothing new', () => {
  const db = makeDb();
  reconcile(db, { changedBy: 'reconcile-grin-gateless' });
  const before = db.prepare('SELECT COUNT(*) n FROM revision_log').get().n;
  const res2 = reconcile(db, { changedBy: 'reconcile-grin-gateless' });
  assert.equal(res2.deleted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revision_log').get().n, before);
});
