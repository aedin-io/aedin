#!/usr/bin/env bash
# smoke-globi-taxonomy-e2e.sh
#
# PLUMBING SMOKE: migration 049 + resolveEntities dry-run + histogram invariant
# on a SYNTHETIC post-re-sync-schema SQLite in $TMPDIR.
#
# WHY SYNTHETIC, NOT A COPY OF globi.sqlite:
#   1. The live DB is ~32 GB — copying to /tmp is impractical and may exhaust
#      the temp partition.
#   2. The live `interactions` table still has the OLD 12-column schema; the 17
#      new GloBI columns (source/target_taxon_ids, pre-split lineage, etc.) are
#      only added when `sync-globi.js --force` runs in the gated T7 rollout.
#      resolveEntities's SELECT (source_taxon_ids, source_kingdom, …) would
#      throw "no such column" against a faithful prod copy.
# Therefore this smoke builds a tiny synthetic DB matching the POST-re-sync /
# POST-migration-049 schema in $TMPDIR.  This asserts the PLUMBING (migration
# 049 applies cleanly; resolveEntities executes its set-based pass and dry-run
# histogram; the invariant holds) — NOT coverage.  Real coverage (~85%
# globi_keyed) is verified LIVE during the T7 rollout after `sync-globi.js
# --force`.  This synthetic approach is a STRONGER plumbing assertion than a
# "0+N==N on empty copy" because we seed mixed GBIF-keyed / no:match /
# disagreement rows and verify a non-trivial invariant.
#
# NEVER point this script at the live globi.sqlite.

set -euo pipefail

DB="${TMPDIR:-/tmp}/globi-taxonomy-smoke-$$.sqlite"
trap 'rm -f "$DB"' EXIT

# Resolve to the backend/ directory regardless of caller cwd
cd "$(dirname "$0")"

node - "$DB" <<'NODE'
'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./migrations/049_entity_lineage_source');
const { resolveEntities } = require('./resolve-entities-from-globi');

const DB = process.argv[2];

(async () => {
  // ── Step 1: build schema + seed with better-sqlite3 (PRE-049, no lineage_source) ──
  const bdb = new Database(DB);
  bdb.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY,
      scientific_name TEXT,
      bio_category TEXT,
      gbif_key INTEGER,
      kingdom TEXT,
      phylum TEXT,
      taxon_class TEXT,
      taxon_order TEXT,
      family TEXT,
      genus TEXT
    );
    CREATE TABLE interactions (
      source_name TEXT,
      target_name TEXT,
      source_taxon_ids TEXT,
      target_taxon_ids TEXT,
      source_kingdom TEXT,
      source_phylum TEXT,
      source_class TEXT,
      source_order TEXT,
      source_family TEXT,
      source_genus TEXT,
      target_kingdom TEXT,
      target_phylum TEXT,
      target_class TEXT,
      target_order TEXT,
      target_family TEXT,
      target_genus TEXT
    );
  `);

  // Entity 1: Apis mellifera — no existing gbif_key; will resolve to GBIF:1346127 → globi_keyed, no disagreement
  // Entity 2: Zea mays — existing gbif_key=999; will resolve to GBIF:2705176 → globi_keyed + 1 disagreement
  // Entity 3: Unknownus fakus — no interaction row → fallback_no_match
  const insEnt = bdb.prepare(`
    INSERT INTO entities (id, scientific_name, bio_category, gbif_key,
      kingdom, phylum, taxon_class, taxon_order, family, genus)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
  `);
  insEnt.run(1, 'Apis mellifera', 'other', null);
  insEnt.run(2, 'Zea mays',       null,    999);
  insEnt.run(3, 'Unknownus fakus',null,    null);

  // One row covers both UNION arms: Apis on source side, Zea on target side.
  const insInt = bdb.prepare(`
    INSERT INTO interactions (
      source_name, target_name,
      source_taxon_ids, target_taxon_ids,
      source_kingdom, source_phylum, source_class, source_order, source_family, source_genus,
      target_kingdom, target_phylum, target_class, target_order, target_family, target_genus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Row 1: Apis (source) ↔ Zea (target) — both get resolved
  insInt.run(
    'Apis mellifera', 'Zea mays',
    'COL:4C67X | GBIF:1346127 | NCBI:2610089', 'GBIF:2705176',
    'Animalia', 'Arthropoda', 'Insecta', 'Hymenoptera', 'Apidae', 'Apis',
    'Plantae', 'Tracheophyta', 'Liliopsida', 'Poales', 'Poaceae', 'Zea'
  );

  // Row 2: no:match source (skipped) + Apis on target arm (reinforces key, proves no:match→null skipped)
  insInt.run(
    'Noise sp.', 'Apis mellifera',
    'no:match', 'GBIF:1346127',
    null, null, null, null, null, null,
    'Animalia', 'Arthropoda', 'Insecta', 'Hymenoptera', 'Apidae', 'Apis'
  );

  bdb.close();

  // ── Step 2: apply migration 049 with sqlite async wrapper ──
  const adb = await open({ filename: DB, driver: sqlite3.Database });
  await runMigration(adb);
  await adb.close();

  // ── Step 3: resolveEntities dry-run with better-sqlite3 ──
  const rdb = new Database(DB);
  const { histogram } = resolveEntities(rdb, { dryRun: true });
  const entityCount = rdb.prepare('SELECT COUNT(*) c FROM entities').get().c;
  const wrote       = rdb.prepare("SELECT COUNT(*) c FROM entities WHERE lineage_source IS NOT NULL").get().c;
  const key2        = rdb.prepare('SELECT gbif_key k FROM entities WHERE id=2').get().k;
  rdb.close();

  // ── Assertions ──
  assert.equal(typeof histogram.globi_keyed,       'number', 'histogram.globi_keyed must be a number');
  assert.equal(typeof histogram.fallback_no_match,  'number', 'histogram.fallback_no_match must be a number');
  assert.equal(typeof histogram.key_disagreements,  'number', 'histogram.key_disagreements must be a number');

  assert.equal(
    histogram.globi_keyed + histogram.fallback_no_match,
    entityCount,
    `PLUMBING INVARIANT: globi_keyed(${histogram.globi_keyed}) + fallback_no_match(${histogram.fallback_no_match}) must equal entityCount(${entityCount})`
  );

  assert.ok(histogram.globi_keyed > 0,      'globi_keyed branch must be exercised (>0)');
  assert.ok(histogram.fallback_no_match > 0, 'fallback_no_match branch must be exercised (>0)');

  assert.equal(histogram.key_disagreements, 1, 'exactly 1 disagreement (entity 2: existing key 999 vs resolved 2705176)');

  assert.equal(wrote, 0,   'DRY-RUN must write nothing (lineage_source IS NOT NULL count == 0)');
  assert.equal(key2,  999, 'DRY-RUN must not overwrite entity 2 existing gbif_key (still 999)');

  console.log('SMOKE OK', JSON.stringify(histogram), 'entities=' + entityCount);
})().catch(e => {
  console.error('SMOKE FAIL:', e.message);
  process.exit(1);
});
NODE

echo "✅ smoke-globi-taxonomy-e2e: PASS"
