'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applyDisposition } = require('./fix-biocontrol-collapse.js');

function db0() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, primary_role TEXT,
    edible INTEGER DEFAULT 0, vegetable INTEGER DEFAULT 0, crop_type TEXT)`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
    interaction_category TEXT, review_status TEXT)`);
  db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT,
    before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

test('untag-weed clears crop_type only when primary_role=weed AND not edible', () => {
  const db = db0();
  db.prepare(`INSERT INTO entities (id,scientific_name,primary_role,edible,vegetable,crop_type) VALUES (965,'Hypericum perforatum','weed',0,0,'vegetable')`).run();
  const r = applyDisposition(db, { kind:'untag-weed', entityId:965 });
  assert.equal(r.changed, true);
  assert.equal(db.prepare('SELECT crop_type FROM entities WHERE id=965').get().crop_type, null);
  // guard: a real edible crop is NOT untagged
  db.prepare(`INSERT INTO entities (id,scientific_name,primary_role,edible,vegetable,crop_type) VALUES (2,'Zea mays','crop',1,0,'grain')`).run();
  const r2 = applyDisposition(db, { kind:'untag-weed', entityId:2 });
  assert.equal(r2.changed, false);
  assert.equal(db.prepare('SELECT crop_type FROM entities WHERE id=2').get().crop_type, 'grain');
  db.close();
});

test('retarget re-points object_entity_id, keeps biocontrol', () => {
  const db = db0();
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,interaction_category,review_status) VALUES (6493036,100,200,'biocontrol','ai_reviewed')`).run();
  const r = applyDisposition(db, { kind:'retarget', claimId:6493036, newObjectId:5842 });
  assert.equal(r.changed, true);
  const c = db.prepare('SELECT object_entity_id,interaction_category FROM claims WHERE id=6493036').get();
  assert.equal(c.object_entity_id, 5842);
  assert.equal(c.interaction_category, 'biocontrol');
  db.close();
});

test('reclassify changes interaction_category', () => {
  const db = db0();
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,interaction_category,review_status) VALUES (6493038,100,300,'biocontrol','ai_reviewed')`).run();
  const r = applyDisposition(db, { kind:'reclassify', claimId:6493038, newCategory:'facilitation' });
  assert.equal(r.changed, true);
  assert.equal(db.prepare('SELECT interaction_category FROM claims WHERE id=6493038').get().interaction_category, 'facilitation');
  db.close();
});

test('reclassify-attractor changes category AND re-points object (gate upgrade path)', () => {
  const db = db0();
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,interaction_category,review_status) VALUES (6492399,100,500,'biocontrol','ai_reviewed')`).run();
  const r = applyDisposition(db, { kind:'reclassify-attractor', claimId:6492399, newCategory:'nectar_provision', newObjectId:777 });
  assert.equal(r.changed, true);
  const c = db.prepare('SELECT interaction_category,object_entity_id FROM claims WHERE id=6492399').get();
  assert.equal(c.interaction_category, 'nectar_provision');
  assert.equal(c.object_entity_id, 777);
  db.close();
});

test('quarantine sets review_status, idempotent', () => {
  const db = db0();
  db.prepare(`INSERT INTO claims (id,subject_entity_id,object_entity_id,interaction_category,review_status) VALUES (6492400,100,400,'biocontrol','ai_reviewed')`).run();
  const r = applyDisposition(db, { kind:'quarantine', claimId:6492400 });
  assert.equal(r.changed, true);
  assert.equal(db.prepare('SELECT review_status FROM claims WHERE id=6492400').get().review_status, 'quarantined_generic');
  const r2 = applyDisposition(db, { kind:'quarantine', claimId:6492400 }); // already done
  assert.equal(r2.changed, false);
  db.close();
});
