'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate072 = require('./072_sim_params_layer');
const migrate073 = require('./073_sim_min_root_depth');
function fresh() { const d = new Database(':memory:'); migrate072(d); migrate073(d); return d; }
const cols = (d) => d.prepare(`PRAGMA table_info(sim_plant_growth)`).all().map((c) => c.name);
test('073 adds min_root_depth_cm', () => { assert.ok(cols(fresh()).includes('min_root_depth_cm')); });
test('073 idempotent', () => { const d = fresh(); migrate073(d); assert.ok(cols(d).includes('min_root_depth_cm')); });
test('073 down removes column', () => { const d = fresh(); migrate073.down(d); assert.ok(!cols(d).includes('min_root_depth_cm')); });
