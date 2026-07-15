'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applyScalarBackfill } = require('./sim-scalar-backfill');
function fresh() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, bio_category TEXT, maximum_height_cm REAL, min_root_depth_cm REAL, growth_habit TEXT);
    CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT, before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')));`);
  db.prepare(`INSERT INTO entities (id,bio_category,maximum_height_cm) VALUES (1,'plantae',NULL)`).run();
  db.prepare(`INSERT INTO entities (id,bio_category,maximum_height_cm) VALUES (2,'plantae',300)`).run();
  db.prepare(`INSERT INTO entities (id,bio_category) VALUES (3,'invertebrate')`).run();
  return db;
}
test('fills NULL, logs revision with source-agnostic method, records backup', () => {
  const db = fresh();
  const r = applyScalarBackfill(db, [{ entity_id: 1, field: 'maximum_height_cm', value: 244 }], { apply: true });
  assert.equal(r.applied, 1);
  assert.equal(db.prepare(`SELECT maximum_height_cm h FROM entities WHERE id=1`).get().h, 244);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM revision_log WHERE method='sim_trait_backfill'`).get().n, 1);
  assert.equal(r.backup[0].entity_id, 1);
});
test('never clobbers non-NULL', () => {
  const db = fresh();
  const r = applyScalarBackfill(db, [{ entity_id: 2, field: 'maximum_height_cm', value: 999 }], { apply: true });
  assert.equal(r.applied, 0);
  assert.equal(db.prepare(`SELECT maximum_height_cm h FROM entities WHERE id=2`).get().h, 300);
});
test('skips non-plantae', () => {
  const db = fresh();
  assert.equal(applyScalarBackfill(db, [{ entity_id: 3, field: 'maximum_height_cm', value: 100 }], { apply: true }).applied, 0);
});
test('dry run writes nothing', () => {
  const db = fresh();
  const r = applyScalarBackfill(db, [{ entity_id: 1, field: 'maximum_height_cm', value: 244 }], { apply: false });
  assert.equal(r.applied, 1);
  assert.equal(db.prepare(`SELECT maximum_height_cm h FROM entities WHERE id=1`).get().h, null);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM revision_log`).get().n, 0);
});
test('rejects out-of-range + disallowed field', () => {
  const db = fresh();
  const r = applyScalarBackfill(db, [
    { entity_id: 1, field: 'maximum_height_cm', value: 99999 },
    { entity_id: 1, field: 'bio_category', value: 'x' },
  ], { apply: true });
  assert.equal(r.applied, 0);
});
test('allows the new service + tolerance fields, range-guards pH', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, bio_category TEXT, cn_ratio TEXT, optimal_ph_min REAL);
    CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT, before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')));`);
  db.prepare(`INSERT INTO entities (id,bio_category) VALUES (1,'plantae')`).run();
  applyScalarBackfill(db, [
    { entity_id: 1, field: 'cn_ratio', value: 'medium' },
    { entity_id: 1, field: 'optimal_ph_min', value: 99 }, // out of range → skipped
    { entity_id: 1, field: 'optimal_ph_min', value: 5.5 },
  ], { apply: true });
  assert.equal(db.prepare(`SELECT cn_ratio FROM entities WHERE id=1`).get().cn_ratio, 'medium');
  assert.equal(db.prepare(`SELECT optimal_ph_min FROM entities WHERE id=1`).get().optimal_ph_min, 5.5);
});
