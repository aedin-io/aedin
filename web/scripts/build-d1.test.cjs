'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { selectReadSubset, sqlVal } = require('./build-d1.cjs');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scope_tier INTEGER, scientific_name TEXT, parent_entity_id INTEGER, bio_category TEXT, variety_type TEXT, needs_taxonomy_review INTEGER DEFAULT 0, merged_into_entity_id INTEGER)`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER,
    object_entity_id INTEGER, source_id INTEGER, staging_id INTEGER, data_tier TEXT,
    review_status TEXT, chain_role TEXT, interaction_category TEXT)`);
  db.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, slug TEXT)`);
  db.exec(`CREATE TABLE claim_critic_verdicts (staging_id INTEGER, critic_name TEXT, verdict TEXT)`);
  db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER,
    trait_name TEXT, value_numeric REAL, value_text TEXT, value_json TEXT, unit TEXT,
    source_id INTEGER, staging_id INTEGER, source_quote TEXT, source_page INTEGER,
    regional_context TEXT, review_status TEXT)`);
  db.exec(`CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT)`);
  db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER,
    field TEXT, before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT,
    applied_at TEXT, subject_entity_id INTEGER, object_entity_id INTEGER, subject_name TEXT,
    object_name TEXT, served INTEGER)`);
  db.exec(`CREATE TABLE entity_common_names (id INTEGER PRIMARY KEY, entity_id INTEGER, name TEXT,
    language TEXT, source TEXT, source_ref TEXT, is_preferred INTEGER, confidence REAL,
    created_at TEXT, updated_at TEXT)`);
  const e = db.prepare('INSERT INTO entities (id, slug, scope_tier, scientific_name) VALUES (?,?,?,?)');
  e.run(1, 'crop', 0, 'Zea mays');
  e.run(2, 'pest', 1, 'Aulacophora indica');
  e.run(3, 'lit-only', null, 'Burkholderia cepacia');
  e.run(4, 'orphan', null, 'Nobody nowhere');
  const c = db.prepare(`INSERT INTO claims (id, subject_entity_id, object_entity_id,
    source_id, staging_id, data_tier, review_status, chain_role) VALUES (?,?,?,?,?,?,?,?)`);
  c.run(10, 2, 1, null, null, 'tier2_globi', 'unreviewed', 'crop_interaction'); // scoped globi
  c.run(11, 3, 1, 100, 500, 'tier1_paper', 'ai_reviewed', null);                 // literature
  c.run(12, 4, 1, null, null, 'tier2_globi', 'unreviewed', null);                // out-of-scope globi (no chain_role)
  db.prepare('INSERT INTO sources (id, slug) VALUES (100, ?)').run('src-a');
  db.prepare('INSERT INTO claim_critic_verdicts (staging_id, critic_name, verdict) VALUES (500, ?, ?)').run('entomologist', 'plausible');
  const cn = db.prepare(`INSERT INTO entity_common_names (entity_id, name, language, source, source_ref, is_preferred, confidence)
    VALUES (?,?,?,?,?,?,?)`);
  cn.run(2, 'garlic', 'en', 'gbif', 'CoL', 0, 0.8);          // served entity -> included
  cn.run(2, 'ajo', 'es', 'wikidata', 'Q23400', 1, 0.8);      // served entity -> included
  cn.run(4, 'orphan-name', 'en', 'gbif', null, 0, 0.8);      // orphan entity -> excluded
  return db;
}

test('sqlVal round-trips newlines, quotes, NULL, numbers, booleans through SQLite', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const samples = [
    "line1\nline2",            // LF
    "win\r\nrow",              // CRLF
    "carriage\rreturn",        // bare CR
    "O'Brien's \"quote\"",     // single quotes
    "plain text",
    "",                         // empty string
  ];
  samples.forEach((s, i) => {
    db.exec(`INSERT INTO t (id, v) VALUES (${i}, ${sqlVal(s)})`);
  });
  samples.forEach((s, i) => {
    const row = db.prepare('SELECT v FROM t WHERE id = ?').get(i);
    assert.equal(row.v, s, `sample ${i} did not round-trip`);
  });
  // non-string scalars
  assert.equal(sqlVal(null), 'NULL');
  assert.equal(sqlVal(undefined), 'NULL');
  assert.equal(sqlVal(42), '42');
  assert.equal(sqlVal(3.14), '3.14');
  assert.equal(sqlVal(true), '1');
  assert.equal(sqlVal(false), '0');
  assert.equal(sqlVal(NaN), 'NULL');
  db.close();
});

test('selectReadSubset includes scoped + literature entities, excludes orphans', () => {
  const db = fixtureDb();
  const sub = selectReadSubset(db);
  const entityIds = sub.entities.map(e => e.id).sort();
  assert.deepEqual(entityIds, [1, 2, 3]);            // 4 (orphan) excluded
  const claimIds = sub.claims.map(c => c.id).sort();
  assert.deepEqual(claimIds, [10, 11]);              // 12 (out-of-scope globi) excluded
  assert.deepEqual(sub.sources.map(s => s.id), [100]);
  assert.deepEqual(sub.verdicts.map(v => v.staging_id), [500]);
  db.close();
});

test('selectReadSubset projects away source columns absent from the D1 schema', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, scope_tier INTEGER, scientific_name TEXT, parent_entity_id INTEGER, merged_into_entity_id INTEGER)`);
  db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER,
    object_entity_id INTEGER, source_id INTEGER, staging_id INTEGER, data_tier TEXT,
    review_status TEXT, chain_role TEXT, mechanism TEXT, interaction_category TEXT)`);   // mechanism: not in D1 schema
  db.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, slug TEXT)`);
  db.exec(`CREATE TABLE claim_critic_verdicts (staging_id INTEGER, critic_name TEXT, verdict TEXT)`);
  db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER,
    trait_name TEXT, value_numeric REAL, value_text TEXT, value_json TEXT, unit TEXT,
    source_id INTEGER, staging_id INTEGER, source_quote TEXT, source_page INTEGER,
    regional_context TEXT, review_status TEXT)`);
  db.exec(`CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT)`);
  db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER,
    field TEXT, before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT,
    applied_at TEXT, subject_entity_id INTEGER, object_entity_id INTEGER, subject_name TEXT,
    object_name TEXT, served INTEGER)`);
  db.exec(`CREATE TABLE entity_common_names (id INTEGER PRIMARY KEY, entity_id INTEGER, name TEXT,
    language TEXT, source TEXT, source_ref TEXT, is_preferred INTEGER, confidence REAL,
    created_at TEXT, updated_at TEXT)`);
  db.prepare('INSERT INTO entities (id, slug, scope_tier, scientific_name) VALUES (1, ?, 0, ?)').run('crop', 'Zea mays');
  db.prepare(`INSERT INTO claims (id, subject_entity_id, object_entity_id, source_id,
    staging_id, data_tier, review_status, chain_role, mechanism)
    VALUES (10, 1, 1, null, null, 'tier2_globi', 'unreviewed', 'crop_interaction', ?)`).run('parasitism');
  const sub = selectReadSubset(db);
  assert.equal(sub.claims.length, 1);
  assert.ok(!('mechanism' in sub.claims[0]), 'mechanism should be projected away (absent from D1 schema)');
  assert.ok('chain_role' in sub.claims[0], 'chain_role should be retained (present in D1 schema)');
  db.close();
});

test('selectReadSubset includes entity_common_names for served entities only, projecting lean columns', () => {
  const db = fixtureDb();
  const sub = selectReadSubset(db);
  // only the served entity's (id 2) names; the orphan (id 4) name is excluded
  const names = sub.commonNames.map(r => r.name).sort();
  assert.deepEqual(names, ['ajo', 'garlic']);
  assert.ok(!sub.commonNames.some(r => r.name === 'orphan-name'), 'orphan-entity name must be excluded');
  // lean column projection: id/confidence/timestamps dropped (absent from D1 schema)
  const cols = Object.keys(sub.commonNames[0]);
  assert.deepEqual(cols.sort(), ['entity_id', 'is_preferred', 'language', 'name', 'source', 'source_ref'].sort());
  db.close();
});

// NOTE: fixtureDb() already inserts entities 1-4; use non-conflicting ids 50/51 here.
test('selectReadSubset materializes inherited parent traits onto served varieties', () => {
  const db = fixtureDb();
  // parent species (id 50) with two ai_reviewed traits; variety (id 51, parent 50) overrides one.
  // bio_category='plantae' required so resolveVarietyTraits' kingdom-guard passes.
  db.prepare(`INSERT INTO entities (id, slug, scope_tier, scientific_name, parent_entity_id, bio_category) VALUES (50,'spp',0,'Brassica oleracea',NULL,'plantae')`).run();
  db.prepare(`INSERT INTO entities (id, slug, scope_tier, scientific_name, parent_entity_id, bio_category) VALUES (51,'spp-var',0,'Brassica oleracea var. italica',50,'plantae')`).run();
  const t = db.prepare(`INSERT INTO entity_trait_claims (id, entity_id, trait_name, value_numeric, review_status) VALUES (?,?,?,?,?)`);
  t.run(500, 50, 'ph_min', 6.0, 'ai_reviewed');         // parent — conserved, must be inherited
  t.run(501, 50, 'hardiness_zone', 7, 'ai_reviewed');    // parent — overridden
  t.run(502, 51, 'hardiness_zone', 8, 'ai_reviewed');    // variety own override
  const sub = selectReadSubset(db);
  const v = sub.traitClaims.filter(r => r.entity_id === 51);
  const byTrait = Object.fromEntries(v.map(r => [r.trait_name, r]));
  // own override present, NOT inherited:
  assert.equal(byTrait.hardiness_zone.value_numeric, 8);
  assert.equal(byTrait.hardiness_zone.inherited_from_entity_id, null);
  // conserved parent trait (ph_min) inherited + flagged:
  assert.equal(byTrait.ph_min.value_numeric, 6.0);
  assert.equal(byTrait.ph_min.inherited_from_entity_id, 50);
  // synthetic id is non-colliding (far above real ids):
  assert.ok(byTrait.ph_min.id >= 51 * 1_000_000_000);
  // every trait row carries the flag key (uniform for insertsFor):
  assert.ok(sub.traitClaims.every(r => 'inherited_from_entity_id' in r));
  db.close();
});
