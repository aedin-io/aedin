'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./072_sim_params_layer');

function fresh() { const d = new Database(':memory:'); migrate(d); return d; }
const TABLES = ['sim_plant_growth', 'sim_pest_dynamics', 'sim_biocontrol', 'sim_visual'];

test('072 creates all four sim_* tables', () => {
  const db = fresh();
  for (const t of TABLES) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
    assert.ok(row, `missing table ${t}`);
  }
});

test('072 enforces the param_status CHECK', () => {
  const db = fresh();
  assert.throws(() => db.prepare(
    `INSERT INTO sim_plant_growth (entity_id, param_status) VALUES (1, 'bogus')`).run(),
    /CHECK/i);
  db.prepare(`INSERT INTO sim_plant_growth (entity_id, param_status) VALUES (1, 'designed')`).run();
});

test('072 enforces UNIQUE keys (row-grained override)', () => {
  const db = fresh();
  db.prepare(`INSERT INTO sim_plant_growth (entity_id, param_status) VALUES (7, 'designed')`).run();
  assert.throws(() => db.prepare(
    `INSERT INTO sim_plant_growth (entity_id, param_status) VALUES (7, 'override')`).run(),
    /UNIQUE/i);
  db.prepare(`INSERT INTO sim_biocontrol (claim_id, param_status) VALUES (99, 'designed')`).run();
  assert.throws(() => db.prepare(
    `INSERT INTO sim_biocontrol (claim_id, param_status) VALUES (99, 'designed')`).run(),
    /UNIQUE/i);
});

test('072 is idempotent and down() drops the tables', () => {
  const db = fresh();
  migrate(db); // second run must not throw
  migrate.down(db);
  for (const t of TABLES) {
    assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), undefined);
  }
});
