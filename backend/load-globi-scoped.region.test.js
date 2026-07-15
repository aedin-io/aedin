'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate052 = require('./migrations/052_claim_localities');
const { runScopedExpansion, SCOPED_TRIPLES_SQL } = require('./load-globi-scoped');

function makeRawDb() {
  // Separate in-memory DB that acts as the "raw" GloBI source.
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE interactions (
      source_name TEXT, target_name TEXT, interaction_type TEXT, location TEXT,
      reference_citation TEXT, reference_doi TEXT, reference_url TEXT);
  `);
  return raw;
}

function fixture() {
  const raw = makeRawDb();
  const rawPath = raw.name; // ':memory:' — we ATTACH via a shared-cache URI trick below
  // Use a shared-cache in-memory URI so both connections see the same data.
  // Better: build both tables in ONE connection and use ATTACH DATABASE '' AS raw
  // (empty string = temp file) — but better-sqlite3 doesn't support shared-cache URIs.
  // Simplest correct approach: create one DB, attach a second in-memory DB as 'raw'.
  const db = new Database(':memory:');
  db.exec(`ATTACH DATABASE ':memory:' AS raw`);
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY, scientific_name TEXT, bio_category TEXT, family TEXT,
      scope_tier INTEGER, primary_role TEXT, crop_type TEXT, edible INTEGER);
    CREATE TABLE raw.interactions (
      source_name TEXT, target_name TEXT, interaction_type TEXT, location TEXT,
      reference_citation TEXT, reference_doi TEXT, reference_url TEXT);
    CREATE TABLE raw.interaction_locality_coverage (
      source_name TEXT, target_name TEXT, country TEXT, subdivision TEXT,
      PRIMARY KEY (source_name, target_name, country, subdivision));
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY,
      subject_entity_id INTEGER, object_entity_id INTEGER, data_tier TEXT,
      interaction_type_raw TEXT, interaction_category TEXT, effect_direction TEXT,
      confidence_score REAL, applied_weight REAL, evidence_tier TEXT,
      valence_confidence TEXT, resolution_path TEXT, mechanism TEXT, impact_class TEXT,
      interaction_count INTEGER, locality_count INTEGER, country TEXT, subdivision TEXT,
      reference_citation TEXT, reference_doi TEXT, reference_url TEXT, source_count INTEGER,
      chain_role TEXT, review_status TEXT);
  `);
  migrate052(db);
  const insE = db.prepare('INSERT INTO entities (scientific_name, bio_category, family, primary_role, crop_type, edible) VALUES (?,?,?,?,?,?)');
  insE.run('Solanum lycopersicum', 'plantae', 'Solanaceae', 'crop', 'vegetable', 1);
  insE.run('Aphis gossypii', 'invertebrate', 'Aphididae', null, null, null);
  insE.run('Tetranychus urticae', 'invertebrate', 'Tetranychidae', null, null, null);
  const insI = db.prepare('INSERT INTO raw.interactions (source_name, target_name, interaction_type, location, reference_citation, reference_doi, reference_url) VALUES (?,?,?,?,?,?,?)');
  insI.run('Aphis gossypii', 'Solanum lycopersicum', 'eats', 'Tamil Nadu', 'ref1', null, null);
  insI.run('Tetranychus urticae', 'Solanum lycopersicum', 'eats', 'somewhere', 'ref2', null, null);
  db.prepare('INSERT INTO raw.interaction_locality_coverage VALUES (?,?,?,?)').run('Aphis gossypii', 'Solanum lycopersicum', 'India', 'Tamil Nadu');
  db.prepare('INSERT INTO raw.interaction_locality_coverage VALUES (?,?,?,?)').run('Aphis gossypii', 'Solanum lycopersicum', 'United States', '');
  return db;
}

test('located pest emits claim + claim_localities; un-located pest is dropped', () => {
  const db = fixture();
  runScopedExpansion(db, { batchSize: 100 });
  const claims = db.prepare("SELECT id, subject_entity_id, object_entity_id FROM claims WHERE data_tier='tier2_globi'").all();
  assert.equal(claims.length, 1);
  const locs = db.prepare('SELECT country, subdivision FROM claim_localities WHERE claim_id = ? ORDER BY country').all(claims[0].id);
  assert.deepEqual(locs, [
    { country: 'India', subdivision: 'Tamil Nadu' },
    { country: 'United States', subdivision: '' },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claim_localities').get().n, 2);
  db.close();
});

test('SCOPED_TRIPLES_SQL: a both-endpoints-in-frontier interaction counts once (UNION ALL + COUNT(DISTINCT rid))', () => {
  const db = new Database(':memory:');
  db.exec(`ATTACH DATABASE ':memory:' AS raw`);
  db.exec(`
    CREATE TABLE raw.interactions (source_name TEXT, target_name TEXT, interaction_type TEXT, location TEXT);
    CREATE TABLE raw.interaction_locality_coverage (source_name TEXT, target_name TEXT, country TEXT, subdivision TEXT);
    CREATE TEMP TABLE _frontier (name TEXT PRIMARY KEY);
  `);
  db.prepare("INSERT INTO _frontier (name) VALUES ('A'),('B')").run();
  // ONE interaction whose BOTH endpoints are in the frontier -> matches BOTH UNION ALL
  // branches. COUNT(DISTINCT rid) must still report cnt=1 (the old UNION+COUNT(*) did).
  db.prepare("INSERT INTO raw.interactions VALUES ('A','B','eats','Loc1')").run();
  const rows = db.prepare(SCOPED_TRIPLES_SQL).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cnt, 1);       // NOT 2
  assert.equal(rows[0].loc_cnt, 1);
  db.close();
});
