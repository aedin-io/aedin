'use strict';
/**
 * Tests for apply-role-rules --unmatched-to-unclassified behavior.
 *
 * Two categories of tests:
 *   A) Engine-level: evaluateRules returns null for a coarse-disabled fungus,
 *      and rescues a curated genus (trichoderma) regardless.
 *   B) Integration-level: reclassifyEntity (the extracted seam) actually writes
 *      'unclassified' + a role_corrections row when the flag is set.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { preloadRules, evaluateRules } = require('./role-engine');

// ── helpers ──────────────────────────────────────────────────────────────────

async function openMemDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  // Tables required by role-engine + apply-role-rules seam
  await db.exec(`
    CREATE TABLE role_rules (
      id INTEGER PRIMARY KEY,
      rule_type TEXT, match_field TEXT,
      match_value TEXT, match_bio_category TEXT,
      assigned_role TEXT, secondary_role TEXT,
      confidence REAL, priority INTEGER,
      reason TEXT, source TEXT, enabled INTEGER
    );

    CREATE TABLE entities (
      id INTEGER PRIMARY KEY,
      scientific_name TEXT,
      common_name TEXT,
      genus TEXT,
      family TEXT,
      bio_category TEXT,
      primary_role TEXT,
      kingdom TEXT,
      phylum TEXT,
      taxon_class TEXT,
      taxon_order TEXT,
      taxonomy_path TEXT,
      parent_entity_id INTEGER,
      merged_into_entity_id INTEGER,
      updated_at TEXT
    );

    CREATE TABLE role_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER,
      scientific_name TEXT,
      old_role TEXT,
      new_role TEXT,
      source TEXT,
      reason TEXT,
      rule_id INTEGER,
      reviewed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE role_assignment_log (
      entity_id INTEGER PRIMARY KEY,
      assigned_role TEXT,
      assignment_source TEXT,
      rule_id INTEGER,
      confidence REAL,
      interaction_profile TEXT,
      assigned_at TEXT
    );
  `);
  return db;
}

async function seedRules(db) {
  // Only an ENABLED genus rule for trichoderma; the fungi class default is DISABLED.
  await db.run(
    "INSERT INTO role_rules (rule_type, match_value, assigned_role, priority, enabled) VALUES ('taxonomy_genus','trichoderma','biocontrol',70,1)"
  );
  await db.run(
    "INSERT INTO role_rules (rule_type, match_value, assigned_role, priority, enabled) VALUES ('taxonomy_class','fungi','pathogen_fungal',30,0)"
  );
}

// ── A: Engine-level tests (pass BEFORE seam extraction) ──────────────────────

test('A1: coarse-disabled fungus → evaluateRules returns null (caller resolves → unclassified)', async () => {
  const db = await openMemDb();
  await seedRules(db);
  const cache = await preloadRules(db);
  const result = await evaluateRules(db,
    { id: 1, scientific_name: 'Coniothyrium minitans', genus: 'coniothyrium', family: '', bio_category: 'fungi', kingdom: 'Fungi', taxon_class: 'Dothideomycetes' },
    null, cache);
  assert.strictEqual(result, null, 'Expected null — coarse class rule is disabled');
  await db.close();
});

test('A2: curated genus (trichoderma) still rescued to biocontrol', async () => {
  const db = await openMemDb();
  await seedRules(db);
  const cache = await preloadRules(db);
  const result = await evaluateRules(db,
    { id: 2, scientific_name: 'Trichoderma virens', genus: 'trichoderma', family: '', bio_category: 'fungi' },
    null, cache);
  assert.ok(result, 'Expected a match');
  assert.strictEqual(result.assignedRole, 'biocontrol');
  await db.close();
});

// ── B: Integration-level tests (require the extracted reclassifyEntity seam) ─

// Lazy-require so A-tests can run (and produce RED evidence) even if the export
// doesn't exist yet — the B-tests will fail with a clear "not a function" error.
function getReclassifyEntity() {
  const mod = require('../apply-role-rules');
  if (typeof mod.reclassifyEntity !== 'function') {
    throw new Error('reclassifyEntity is not exported from apply-role-rules.js — implement the seam');
  }
  return mod.reclassifyEntity;
}

test('B1: reclassifyEntity with unmatchedToUnclassified=true assigns unclassified + logs role_corrections', async () => {
  const reclassifyEntity = getReclassifyEntity();
  const db = await openMemDb();
  await seedRules(db);

  // Seed a fungal entity currently labelled pathogen_fungal (false positive from old coarse rule)
  await db.run(`INSERT INTO entities
    (id, scientific_name, genus, family, bio_category, primary_role, kingdom, taxon_class, parent_entity_id, merged_into_entity_id)
    VALUES (10, 'Coniothyrium minitans', 'coniothyrium', '', 'fungi', 'pathogen_fungal', 'Fungi', 'Dothideomycetes', NULL, NULL)`);

  const cache = await preloadRules(db);
  const entity = await db.get('SELECT * FROM entities WHERE id = 10');

  await reclassifyEntity(db, entity, cache, {
    unmatchedToUnclassified: true,
    respectCorrections: false,
    correctedIds: new Set(),
    dryRun: false,
    profile: null,
  });

  const updated = await db.get('SELECT primary_role FROM entities WHERE id = 10');
  assert.strictEqual(updated.primary_role, 'unclassified',
    'Entity should be demoted to unclassified when no rule matches + flag is set');

  const correction = await db.get('SELECT * FROM role_corrections WHERE entity_id = 10');
  assert.ok(correction, 'A role_corrections row should be written');
  assert.strictEqual(correction.old_role, 'pathogen_fungal');
  assert.strictEqual(correction.new_role, 'unclassified');

  await db.close();
});

test('B2: reclassifyEntity rescues Trichoderma virens to biocontrol (curated genus wins, NOT unclassified)', async () => {
  const reclassifyEntity = getReclassifyEntity();
  const db = await openMemDb();
  await seedRules(db);

  // Seed Trichoderma entity currently unclassified
  await db.run(`INSERT INTO entities
    (id, scientific_name, genus, family, bio_category, primary_role, kingdom, taxon_class, parent_entity_id, merged_into_entity_id)
    VALUES (20, 'Trichoderma virens', 'trichoderma', '', 'fungi', 'unclassified', 'Fungi', NULL, NULL, NULL)`);

  const cache = await preloadRules(db);
  const entity = await db.get('SELECT * FROM entities WHERE id = 20');

  await reclassifyEntity(db, entity, cache, {
    unmatchedToUnclassified: true,
    respectCorrections: false,
    correctedIds: new Set(),
    dryRun: false,
    profile: null,
  });

  const updated = await db.get('SELECT primary_role FROM entities WHERE id = 20');
  assert.strictEqual(updated.primary_role, 'biocontrol',
    'Trichoderma should be rescued to biocontrol via the genus rule');

  await db.close();
});

test('B3: reclassifyEntity respects dry-run — no DB changes', async () => {
  const reclassifyEntity = getReclassifyEntity();
  const db = await openMemDb();
  await seedRules(db);

  await db.run(`INSERT INTO entities
    (id, scientific_name, genus, family, bio_category, primary_role, kingdom, taxon_class, parent_entity_id, merged_into_entity_id)
    VALUES (30, 'Coniothyrium minitans', 'coniothyrium', '', 'fungi', 'pathogen_fungal', 'Fungi', 'Dothideomycetes', NULL, NULL)`);

  const cache = await preloadRules(db);
  const entity = await db.get('SELECT * FROM entities WHERE id = 30');

  await reclassifyEntity(db, entity, cache, {
    unmatchedToUnclassified: true,
    respectCorrections: false,
    correctedIds: new Set(),
    dryRun: true,  // DRY RUN
    profile: null,
  });

  // Role should be UNCHANGED in dry-run
  const unchanged = await db.get('SELECT primary_role FROM entities WHERE id = 30');
  assert.strictEqual(unchanged.primary_role, 'pathogen_fungal',
    'Dry-run must not mutate the DB');

  const correction = await db.get('SELECT * FROM role_corrections WHERE entity_id = 30');
  assert.strictEqual(correction, undefined, 'No role_corrections row in dry-run');

  await db.close();
});

test('B4: reclassifyEntity skips entity already at unclassified (idempotent)', async () => {
  const reclassifyEntity = getReclassifyEntity();
  const db = await openMemDb();
  await seedRules(db);

  await db.run(`INSERT INTO entities
    (id, scientific_name, genus, family, bio_category, primary_role, kingdom, taxon_class, parent_entity_id, merged_into_entity_id)
    VALUES (40, 'Unknown fungus', 'unknownus', '', 'fungi', 'unclassified', 'Fungi', NULL, NULL, NULL)`);

  const cache = await preloadRules(db);
  const entity = await db.get('SELECT * FROM entities WHERE id = 40');

  await reclassifyEntity(db, entity, cache, {
    unmatchedToUnclassified: true,
    respectCorrections: false,
    correctedIds: new Set(),
    dryRun: false,
    profile: null,
  });

  // Still unclassified, no spurious correction written
  const row = await db.get('SELECT primary_role FROM entities WHERE id = 40');
  assert.strictEqual(row.primary_role, 'unclassified');
  const correction = await db.get('SELECT * FROM role_corrections WHERE entity_id = 40');
  assert.strictEqual(correction, undefined, 'No correction written when already unclassified');

  await db.close();
});

test('B5: reclassifyEntity respects respectCorrections flag', async () => {
  const reclassifyEntity = getReclassifyEntity();
  const db = await openMemDb();
  await seedRules(db);

  await db.run(`INSERT INTO entities
    (id, scientific_name, genus, family, bio_category, primary_role, kingdom, taxon_class, parent_entity_id, merged_into_entity_id)
    VALUES (50, 'Coniothyrium minitans', 'coniothyrium', '', 'fungi', 'pathogen_fungal', 'Fungi', 'Dothideomycetes', NULL, NULL)`);

  const cache = await preloadRules(db);
  const entity = await db.get('SELECT * FROM entities WHERE id = 50');

  // Mark this entity as manually corrected
  await reclassifyEntity(db, entity, cache, {
    unmatchedToUnclassified: true,
    respectCorrections: true,
    correctedIds: new Set([50]),  // entity 50 is protected
    dryRun: false,
    profile: null,
  });

  // Role should not change — it's protected
  const row = await db.get('SELECT primary_role FROM entities WHERE id = 50');
  assert.strictEqual(row.primary_role, 'pathogen_fungal',
    'Protected entity must not be reassigned');

  await db.close();
});
