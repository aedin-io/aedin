'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./migrations/061_entity_common_names');
const { derivePreferredEnglish, run } = require('./derive-display-name');

function db0() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, common_name TEXT, scientific_name TEXT, updated_at TEXT);
           CREATE TABLE revision_log (id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id INTEGER,
             field TEXT, before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT,
             applied_at TEXT DEFAULT (datetime('now')));`);
  migrate(db);
  return db;
}

test('derivePreferredEnglish: preferred-en > plain-en > null', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id, scientific_name, common_name) VALUES (1,'Allium sativum','Aglio comune')").run();
  // a non-preferred English (gbif) and a preferred English (wikidata label)
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source,is_preferred) VALUES (1,'garlic plant','en','gbif',0)").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source,is_preferred) VALUES (1,'Garlic','en','wikidata',1)").run();
  assert.equal(derivePreferredEnglish(db, 1), 'Garlic');   // preferred wins
  db.close();
});

test('derivePreferredEnglish: null when no English name exists', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id, scientific_name) VALUES (2,'Anatis ocellata')").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source) VALUES (2,'Augenfleck-Marienkäfer','de','gbif')").run();
  assert.equal(derivePreferredEnglish(db, 2), null);
  db.close();
});

test('run overwrites common_name unconditionally and logs the change', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id, scientific_name, common_name) VALUES (1,'Allium sativum','Aglio comune')").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source,is_preferred) VALUES (1,'Garlic','en','wikidata',1)").run();
  run(db, { changedBy: 'test' });
  assert.equal(db.prepare('SELECT common_name FROM entities WHERE id=1').get().common_name, 'Garlic');
  const rev = db.prepare("SELECT before_value, after_value, field FROM revision_log WHERE target_id=1").get();
  assert.deepEqual([rev.field, rev.before_value, rev.after_value], ['common_name', 'Aglio comune', 'Garlic']);
  db.close();
});

test('run writes no revision_log row when the derived name already matches', () => {
  const db = db0();
  // entity already has the correct English display name
  db.prepare("INSERT INTO entities (id, scientific_name, common_name) VALUES (1,'Allium sativum','Garlic')").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source,is_preferred) VALUES (1,'Garlic','en','wikidata',1)").run();
  run(db, { changedBy: 'test' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revision_log WHERE target_id=1").get().n, 0);
  assert.equal(db.prepare('SELECT common_name FROM entities WHERE id=1').get().common_name, 'Garlic');
  db.close();
});

test('derivePreferredEnglish prefers a real common name over a pseudo-scientific one', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id, scientific_name) VALUES (1,'Calvia quatuordecimguttata')").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source) VALUES (1,'Calvia 14-guttata','en','gbif')").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source) VALUES (1,'Cream-Spot Ladybird','en','gbif')").run();
  assert.equal(derivePreferredEnglish(db, 1), 'Cream-Spot Ladybird');
  db.close();
});

test('derivePreferredEnglish returns null when the only English name restates the genus', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id, scientific_name) VALUES (1,'Calvia quatuordecimguttata')").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source) VALUES (1,'Calvia 14-guttata','en','gbif')").run();
  assert.equal(derivePreferredEnglish(db, 1), null);  // -> scientific fallback
  db.close();
});

test('derivePreferredEnglish returns null when the only English name is an abbreviation', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id, scientific_name) VALUES (1,'Propylea quattuordecimpunctata')").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source) VALUES (1,'P14','en','gbif')").run();
  assert.equal(derivePreferredEnglish(db, 1), null);
  db.close();
});

test('derivePreferredEnglish keeps legitimate spot-count names (digits are fine)', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id, scientific_name) VALUES (1,'Adalia bipunctata')").run();
  db.prepare("INSERT INTO entity_common_names (entity_id,name,language,source) VALUES (1,'2-spot Ladybird','en','gbif')").run();
  assert.equal(derivePreferredEnglish(db, 1), '2-spot Ladybird');
  db.close();
});
