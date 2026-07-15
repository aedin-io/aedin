'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m032 } = require('./migrations/032_entity_trait_claims');
const { runMigration: m033 } = require('./migrations/033_traits_vocabulary');
const { runMigration: m025 } = require('./migrations/025_claim_critic_verdicts');
const { runMigration: m036 } = require('./migrations/036_critic_verdict_confidence');
const { promoteEntityTraitRow, resolveEntityForClaim, _resetVocabCache } = require('./promote-staged-claims');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY,
      scientific_name TEXT NOT NULL UNIQUE,
      common_name TEXT,
      variety_name TEXT,
      parent_entity_id INTEGER,
      bio_category TEXT,
      primary_role TEXT,
      data_completeness TEXT,
      source_table TEXT,
      needs_dedup INTEGER DEFAULT 0,
      taxonomic_resolution TEXT,
      crop_type TEXT,
      edible INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT, source_type TEXT);
    CREATE TABLE extraction_staging (
      id INTEGER PRIMARY KEY, queue_id INTEGER, source_id INTEGER,
      target_table TEXT, payload TEXT, review_status TEXT,
      ai_vouch_status TEXT, created_at TEXT, reviewed_at TEXT,
      entity_resolution_status TEXT, resolved_subject_entity_id INTEGER, resolved_object_entity_id INTEGER);
  `);
  await m025(db);
  await m032(db);
  await m033(db);
  await m036(db);
  return db;
}

test('promoteEntityTraitRow inserts entity_trait_claims row with correct value column', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'Pedigo 2021', 'book')`);
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, source_table, data_completeness, created_at, updated_at) VALUES (1, 'Plutella xylostella', 'invertebrate', 'pest_insect', 'manual', 'minimal', datetime('now'), datetime('now'))`);
  const payload = {
    scientific_name: 'Plutella xylostella',
    trait_name: 'thermal_min',
    value_numeric: 7.3,
    unit: '°C',
    regional_context: 'Global',
    source_quote: 'Lower threshold 7.3°C',
    source_page: 214,
  };
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload, source_id, ai_vouch_status, review_status) VALUES (10, 'entity_trait', ?, 1, 'plausible', 'unreviewed')`,
    [JSON.stringify(payload)]);
  const stagingRow = await db.get('SELECT * FROM extraction_staging WHERE id = 10');
  const result = await promoteEntityTraitRow(db, stagingRow);
  assert.equal(result.skip, false);
  const row = await db.get(`SELECT * FROM entity_trait_claims WHERE staging_id = 10`);
  assert.ok(row);
  assert.equal(row.entity_id, 1);
  assert.equal(row.trait_name, 'thermal_min');
  assert.equal(row.value_numeric, 7.3);
  assert.equal(row.unit, '°C');
  assert.equal(row.review_status, 'ai_reviewed');
});

test('promoteEntityTraitRow promotes a trait with NO resolvable locality (locality gate does not apply to intrinsic traits)', async () => {
  // An intrinsic species trait (edible_part, life_cycle, thermal_min...) is not
  // regional, so trait promotion must NOT require a resolvable locality the way
  // interaction-claim promotion does. The main loop enforces this structurally
  // (entity_trait rows route to promoteEntityTraitRow and `continue` BEFORE the
  // locality gate); this test pins the invariant at the function level so a
  // future locality check added here would fail loudly.
  const db = await freshDb();
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'World Vegetables', 'book')`);
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, source_table, data_completeness, created_at, updated_at) VALUES (1, 'Solanum tuberosum', 'plantae', 'crop', 'manual', 'minimal', datetime('now'), datetime('now'))`);
  const payload = {
    scientific_name: 'Solanum tuberosum',
    trait_name: 'thermal_min',
    value_numeric: 2.0,
    unit: '°C',
    // regional_context intentionally omitted — the trait has no locality.
    source_quote: 'Potato growth ceases below 2°C',
    source_page: 1,
  };
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload, source_id, ai_vouch_status, review_status) VALUES (20, 'entity_trait', ?, 1, 'plausible', 'unreviewed')`,
    [JSON.stringify(payload)]);
  const stagingRow = await db.get('SELECT * FROM extraction_staging WHERE id = 20');
  const result = await promoteEntityTraitRow(db, stagingRow);
  assert.equal(result.skip, false); // NOT skipped for lack of locality
  const row = await db.get(`SELECT * FROM entity_trait_claims WHERE staging_id = 20`);
  assert.ok(row, 'trait claim should be promoted despite no regional_context');
  assert.equal(row.regional_context, null);
});

test('promoteEntityTraitRow rejects payload with unknown trait_name', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'X', 'book')`);
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, source_table, data_completeness, created_at, updated_at) VALUES (1, 'X sp.', 'invertebrate', 'pest_insect', 'manual', 'minimal', datetime('now'), datetime('now'))`);
  const payload = { scientific_name: 'X sp.', trait_name: 'foo_bar', value_numeric: 1, unit: 'x' };
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload, source_id, ai_vouch_status, review_status) VALUES (11, 'entity_trait', ?, 1, 'plausible', 'unreviewed')`,
    [JSON.stringify(payload)]);
  const stagingRow = await db.get('SELECT * FROM extraction_staging WHERE id = 11');
  const result = await promoteEntityTraitRow(db, stagingRow);
  assert.equal(result.skip, true);
  assert.match(result.reason, /unknown trait/);
});

test('promoteEntityTraitRow encodes range value_kind into value_json', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'X', 'book')`);
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, source_table, data_completeness, created_at, updated_at) VALUES (1, 'X sp.', 'invertebrate', 'pest_insect', 'manual', 'minimal', datetime('now'), datetime('now'))`);
  const payload = {
    scientific_name: 'X sp.', trait_name: 'favorable_humidity',
    value_json: { min: 70, max: 95 }, unit: '%RH',
    source_quote: 'q', source_page: 1,
  };
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload, source_id, ai_vouch_status, review_status) VALUES (12, 'entity_trait', ?, 1, 'plausible', 'unreviewed')`,
    [JSON.stringify(payload)]);
  const stagingRow = await db.get('SELECT * FROM extraction_staging WHERE id = 12');
  await promoteEntityTraitRow(db, stagingRow);
  const row = await db.get(`SELECT value_json FROM entity_trait_claims WHERE staging_id = 12`);
  assert.deepEqual(JSON.parse(row.value_json), { min: 70, max: 95 });
});

test('resolveEntityForClaim returns species entity when variety_name is null', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop')`);
  const e = await resolveEntityForClaim(db, 'Solanum lycopersicum', null);
  assert.equal(e.id, 100);
});

test('resolveEntityForClaim auto-creates variety entity when not found', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, common_name) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop', 'tomato')`);
  const e = await resolveEntityForClaim(db, 'Solanum lycopersicum', 'Solar Fire');
  assert.notEqual(e.id, 100, 'should be a NEW row, not the species row');
  const row = await db.get('SELECT scientific_name, variety_name, parent_entity_id, needs_dedup FROM entities WHERE id = ?', e.id);
  assert.equal(row.variety_name, 'Solar Fire');
  assert.equal(row.parent_entity_id, 100);
  assert.equal(row.needs_dedup, 1);
});

test('resolveEntityForClaim returns existing variety entity when found', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop')`);
  await db.run(`INSERT INTO entities (id, scientific_name, variety_name, parent_entity_id, bio_category) VALUES (200, 'Solanum lycopersicum ''Solar Fire''', 'Solar Fire', 100, 'plantae')`);
  const e = await resolveEntityForClaim(db, 'Solanum lycopersicum', 'Solar Fire');
  assert.equal(e.id, 200);
});

test('resolveEntityForClaim normalizes variety_name before lookup', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop')`);
  await db.run(`INSERT INTO entities (id, scientific_name, variety_name, parent_entity_id, bio_category) VALUES (200, 'Solanum lycopersicum ''Solar Fire''', 'Solar Fire', 100, 'plantae')`);
  // Input has trademark + whitespace — should still match the existing row
  const e = await resolveEntityForClaim(db, 'Solanum lycopersicum', '  Solar Fire™  ');
  assert.equal(e.id, 200);
});

test('resolveEntityForClaim auto-creates TWO distinct cultivars under the same parent', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, common_name) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop', 'tomato')`);
  const { resolveEntityForClaim } = require('./promote-staged-claims');
  const e1 = await resolveEntityForClaim(db, 'Solanum lycopersicum', 'Solar Fire');
  const e2 = await resolveEntityForClaim(db, 'Solanum lycopersicum', 'Beefsteak');
  assert.ok(e1 && e2);
  assert.notEqual(e1.id, e2.id, 'two cultivars must get distinct rows');
  const rows = await db.all(`SELECT scientific_name, variety_name, parent_entity_id FROM entities WHERE parent_entity_id = 100 ORDER BY id`);
  assert.equal(rows.length, 2);
  // scientific_name will be the compound form (must be distinct between rows since UNIQUE)
  assert.notEqual(rows[0].scientific_name, rows[1].scientific_name);
  assert.equal(rows[0].variety_name, 'Solar Fire');
  assert.equal(rows[1].variety_name, 'Beefsteak');
});

const { claimEntityFields } = require('./promote-staged-claims');

test('claimEntityFields prefers staging resolved ids and carries status', () => {
  const staging = {
    entity_resolution_status: 'fuzzy_verified',
    resolved_subject_entity_id: 7,
    resolved_object_entity_id: 9,
  };
  const out = claimEntityFields(staging, { subjectId: null, objectId: null });
  assert.equal(out.subject_entity_id, 7);
  assert.equal(out.object_entity_id, 9);
  assert.equal(out.entity_resolution_status, 'fuzzy_verified');
});

test('claimEntityFields keeps an already-resolved id from the legacy path', () => {
  const staging = { entity_resolution_status: 'verified', resolved_subject_entity_id: null, resolved_object_entity_id: 9 };
  const out = claimEntityFields(staging, { subjectId: 3, objectId: null });
  assert.equal(out.subject_entity_id, 3); // legacy resolver already found it
  assert.equal(out.object_entity_id, 9);  // filled from staging
});

// --- crop-gate: crop-anchored growth traits require a crop anchor -----------
// maximum_height_cm is NOT seeded by migration 033, so insert it and reset the
// module-level vocab cache to keep the test deterministic regardless of order.
async function seedGatedTrait(db) {
  await db.run(`INSERT OR REPLACE INTO traits_vocabulary
    (trait_name, value_kind, expected_unit, applicable_bio_categories, description, introduced_at)
    VALUES ('maximum_height_cm','numeric','cm','["plantae"]','max height', datetime('now'))`);
  _resetVocabCache();
}

test('crop-gate: rejects a crop-anchored trait on a NON-crop entity', async () => {
  const db = await freshDb();
  await seedGatedTrait(db);
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'CTAHR EB16', 'extension_bulletin')`);
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, crop_type, edible, source_table, data_completeness, created_at, updated_at) VALUES (1, 'Bidens pilosa', 'plantae', 'unclassified', NULL, 0, 'manual', 'minimal', datetime('now'), datetime('now'))`);
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload, source_id, ai_vouch_status, review_status) VALUES (30, 'entity_trait', ?, 1, 'plausible', 'unreviewed')`,
    [JSON.stringify({ scientific_name: 'Bidens pilosa', trait_name: 'maximum_height_cm', value_numeric: 90, unit: 'cm' })]);
  const row = await db.get('SELECT * FROM extraction_staging WHERE id = 30');
  const result = await promoteEntityTraitRow(db, row);
  assert.equal(result.skip, true);
  assert.match(result.reason, /crop-gate/);
});

test('crop-gate: allows a crop-anchored trait on a crop entity (edible=1)', async () => {
  const db = await freshDb();
  await seedGatedTrait(db);
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'CTAHR EB16', 'extension_bulletin')`);
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, crop_type, edible, source_table, data_completeness, created_at, updated_at) VALUES (1, 'Solanum lycopersicum', 'plantae', 'crop', NULL, 1, 'manual', 'minimal', datetime('now'), datetime('now'))`);
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload, source_id, ai_vouch_status, review_status) VALUES (31, 'entity_trait', ?, 1, 'plausible', 'unreviewed')`,
    [JSON.stringify({ scientific_name: 'Solanum lycopersicum', trait_name: 'maximum_height_cm', value_numeric: 180, unit: 'cm' })]);
  const row = await db.get('SELECT * FROM extraction_staging WHERE id = 31');
  const result = await promoteEntityTraitRow(db, row);
  assert.equal(result.skip, false);
  const claim = await db.get(`SELECT value_numeric FROM entity_trait_claims WHERE staging_id = 31`);
  assert.equal(claim.value_numeric, 180);
});

test('crop-gate: does NOT gate a non-crop-anchored trait (thermal_min) on a non-crop entity', async () => {
  const db = await freshDb();
  _resetVocabCache();
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'Pedigo', 'book')`);
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role, crop_type, edible, source_table, data_completeness, created_at, updated_at) VALUES (1, 'Plutella xylostella', 'invertebrate', 'pest_insect', NULL, 0, 'manual', 'minimal', datetime('now'), datetime('now'))`);
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload, source_id, ai_vouch_status, review_status) VALUES (32, 'entity_trait', ?, 1, 'plausible', 'unreviewed')`,
    [JSON.stringify({ scientific_name: 'Plutella xylostella', trait_name: 'thermal_min', value_numeric: 7.3, unit: '°C' })]);
  const row = await db.get('SELECT * FROM extraction_staging WHERE id = 32');
  const result = await promoteEntityTraitRow(db, row);
  assert.equal(result.skip, false); // pest trait must still promote
});
