'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./074_sim_ecosystem_service');
function fresh() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, bio_category TEXT);`);
  migrate(d); return d;
}
const ecols = (d) => d.prepare(`PRAGMA table_info(entities)`).all().map((c) => c.name);
const NEW = ['cn_ratio','fertility_requirement','soil_texture_adaptation','anaerobic_tolerance','caco3_tolerance','salinity_tolerance','drought_tolerance','moisture_use'];
test('074 adds the entities tolerance/nutrient columns', () => {
  const c = ecols(fresh());
  for (const n of NEW) assert.ok(c.includes(n), `missing ${n}`);
});
test('074 creates sim_ecosystem_service with the envelope', () => {
  const d = fresh();
  const cols = d.prepare(`PRAGMA table_info(sim_ecosystem_service)`).all().map((c) => c.name);
  for (const n of ['entity_id','nitrogen_fixation_class','residue_decomposition','soil_functions','param_status','confidence']) assert.ok(cols.includes(n), `missing ${n}`);
});
test('074 is idempotent + down reverses', () => {
  const d = fresh(); migrate(d); // 2nd run no throw
  migrate.down(d);
  assert.ok(!ecols(d).includes('cn_ratio'));
  assert.equal(d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sim_ecosystem_service'`).get(), undefined);
});
