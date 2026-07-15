'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./063_grin_varieties_staging.js');

test('migration creates grin_varieties (idempotent)', () => {
  const db = new Database(':memory:');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(grin_varieties)').all().map(c => c.name).sort();
  assert.deepEqual(cols, ['grin_accession','improvement_level','narrative','origin','parent_entity_id','plant_name','promoted_at','scraped_at']);
  migrate(db); // idempotent — no throw
  db.close();
});
