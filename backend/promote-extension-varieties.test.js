'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { promoteOne } = require('./promote-extension-varieties.js');

function db0() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, common_name TEXT,
    variety_name TEXT, parent_entity_id INTEGER, bio_category TEXT, primary_role TEXT,
    source_table TEXT, scope_tier INTEGER, native_regions TEXT, needs_dedup INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER, trait_name TEXT,
    value_numeric REAL, value_text TEXT, source_id INTEGER, source_quote TEXT, regional_context TEXT,
    review_status TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT, url TEXT, source_type TEXT, slug TEXT)`);
  db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT,
    before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')))`);
  // parent species
  db.prepare(`INSERT INTO entities (id, scientific_name, parent_entity_id) VALUES (100,'Solanum lycopersicum',NULL)`).run();
  return db;
}
const row = (o={}) => ({ species_name:'Solanum lycopersicum', variety_name:'Sungold', region:'California',
  source_name:'UC Davis', source_url:'http://x', maturity_days:65, ...o });

test('promotes a new variety + days_to_harvest claim with provenance', () => {
  const db = db0();
  const r = promoteOne(db, row());
  assert.equal(r.action, 'create');
  assert.equal(r.traitWritten, true);
  const e = db.prepare("SELECT * FROM entities WHERE id=?").get(r.entityId);
  assert.equal(e.scientific_name, "Solanum lycopersicum 'Sungold'");
  assert.equal(e.parent_entity_id, 100);
  assert.equal(e.scope_tier, 0);
  assert.equal(e.source_table, 'extension_scrape');
  const t = db.prepare("SELECT * FROM entity_trait_claims WHERE entity_id=?").get(r.entityId);
  assert.equal(t.trait_name, 'days_to_harvest');
  assert.equal(t.value_numeric, 65);
  assert.equal(t.review_status, 'ai_reviewed');
  assert.equal(t.regional_context, 'California');
  assert.ok(t.source_id);
  db.close();
});

test('parent-required gate: no parent -> skip, no entity', () => {
  const db = db0();
  const r = promoteOne(db, row({ species_name: 'Nonexistent plantus' }));
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'no_parent');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entities WHERE parent_entity_id IS NOT NULL').get().n, 0);
  db.close();
});

test('completeness gate: no maturity_days -> skip', () => {
  const db = db0();
  const r = promoteOne(db, row({ maturity_days: null }));
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'no_traits');
  db.close();
});

test('near-dup -> create + needs_dedup=1 (not auto-merged)', () => {
  const db = db0();
  promoteOne(db, row({ variety_name: 'Brandywine' }));
  const r = promoteOne(db, row({ variety_name: 'Brandywime' }));   // dist 1
  assert.equal(r.action, 'create-flag');
  assert.equal(db.prepare("SELECT needs_dedup FROM entities WHERE id=?").get(r.entityId).needs_dedup, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entities WHERE parent_entity_id=100").get().n, 2); // both kept
  db.close();
});

test('idempotent: re-promoting the same row makes no new entity or claim', () => {
  const db = db0();
  promoteOne(db, row());
  const before = db.prepare('SELECT (SELECT COUNT(*) FROM entities) e, (SELECT COUNT(*) FROM entity_trait_claims) t').get();
  const r2 = promoteOne(db, row());
  assert.equal(r2.action, 'update');
  const after = db.prepare('SELECT (SELECT COUNT(*) FROM entities) e, (SELECT COUNT(*) FROM entity_trait_claims) t').get();
  assert.deepEqual(after, before);
  db.close();
});
