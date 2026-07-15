#!/usr/bin/env node
'use strict';

/**
 * reclassify-crops-from-ecocrop.js
 *
 * Promotes plant entities whose scientific name appears in FAO ECOCROP
 * from primary_role='weed' to primary_role='crop'.
 *
 * Rationale:
 *   ECOCROP's 2,500 SCIENTNAMEs are FAO-curated food / agricultural crops.
 *   If a GloBI plant entity matches ECOCROP, it's almost certainly a crop.
 *   Prior to this step the entities table had ~1,350 misclassified food
 *   crops (okra, pineapple, dill, celery, etc.) sitting in the weed bucket.
 *
 * Match logic:
 *   Case-insensitive exact match on full scientific_name, OR genus+species
 *   prefix match (strips taxonomic authority suffixes like "L." / "Medic").
 *
 * Safety:
 *   - Default mode promotes ONLY weed→crop. Other roles (pest_*, beneficial_*,
 *     etc.) are left untouched — those come from interaction evidence and
 *     overruling them would cost more context than it buys.
 *   - --dry-run shows candidates without writing.
 *   - --force promotes any non-crop role (still won't touch pest/beneficial —
 *     use with care).
 *
 * Also sets edible=1 on promoted entities (ECOCROP entries are by
 * definition cultivated for food/fiber).
 *
 * Usage:
 *   node reclassify-crops-from-ecocrop.js --dry-run
 *   node reclassify-crops-from-ecocrop.js
 *   node reclassify-crops-from-ecocrop.js --force
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { expandEcoCropKeys } = require('./lib/ecocrop-synonyms');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const CSV_PATH = path.join(__dirname, 'data', 'ecocrop', 'ecocrop.csv');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// Roles we refuse to touch even with --force (interaction-evidence-backed).
const PROTECTED_ROLES = new Set([
  'pest_insect', 'pest_mite', 'pest_vertebrate',
  'pathogen_fungal', 'pathogen_bacterial', 'pathogen_viral', 'pathogen_nematode',
  'beneficial_predator', 'beneficial_parasitoid', 'biocontrol',
  'pollinator', 'soil_microbe',
]);

function norm(s) {
  return s == null ? '' : String(s).trim().toLowerCase();
}

function buildEcoKeys() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`Missing ${CSV_PATH}. Run: bash download-ecocrop.sh`);
    process.exit(1);
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  const keys = new Set();
  for (const r of rows) {
    for (const k of expandEcoCropKeys(r.SCIENTNAME)) keys.add(k);
  }
  return { keys, rowCount: rows.length };
}

async function main() {
  console.log('reclassify-crops-from-ecocrop.js');
  console.log(`  dry-run: ${DRY_RUN}`);
  console.log(`  force:   ${FORCE}`);

  const { keys, rowCount } = buildEcoKeys();
  console.log(`  Loaded ${rowCount} ECOCROP rows → ${keys.size} unique name keys`);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA busy_timeout = 30000');

  const ents = await db.all(`
    SELECT id, scientific_name, primary_role, edible
    FROM entities
    WHERE bio_category = 'plantae'
      AND parent_entity_id IS NULL
      AND scientific_name IS NOT NULL
  `);
  console.log(`  Candidates (all plant species): ${ents.length}`);

  const promotions = [];
  const skippedProtected = [];
  let alreadyCrop = 0, noMatch = 0;

  for (const e of ents) {
    const k = norm(e.scientific_name);
    const t = k.split(/\s+/);
    const match = keys.has(k) || (t.length >= 2 && keys.has(`${t[0]} ${t[1]}`));
    if (!match) { noMatch++; continue; }

    if (e.primary_role === 'crop') { alreadyCrop++; continue; }

    if (PROTECTED_ROLES.has(e.primary_role)) {
      skippedProtected.push(e);
      continue;
    }

    if (!FORCE && e.primary_role !== 'weed') continue;

    promotions.push(e);
  }

  console.log('');
  console.log(`  ECOCROP-matched:      ${ents.length - noMatch}`);
  console.log(`    already crop:       ${alreadyCrop}`);
  console.log(`    to promote:         ${promotions.length}`);
  console.log(`    skipped (protected): ${skippedProtected.length}`);
  console.log('');

  if (skippedProtected.length > 0) {
    console.log('  Sample protected roles kept (interaction evidence overrides ECOCROP):');
    skippedProtected.slice(0, 5).forEach(e =>
      console.log(`    ${e.scientific_name.padEnd(35)} role=${e.primary_role}`)
    );
    console.log('');
  }

  if (DRY_RUN) {
    console.log('--dry-run set, no changes written. Sample promotions:');
    promotions.slice(0, 10).forEach(e =>
      console.log(`    ${e.scientific_name.padEnd(35)} ${e.primary_role} → crop`)
    );
    await db.close();
    return;
  }

  if (promotions.length === 0) {
    console.log('No promotions to apply.');
    await db.close();
    return;
  }

  const stmt = await db.prepare(
    "UPDATE entities SET primary_role = 'crop', edible = 1, updated_at = datetime('now') WHERE id = ?"
  );
  await db.exec('BEGIN');
  for (const e of promotions) {
    await stmt.run(e.id);
  }
  await db.exec('COMMIT');
  await stmt.finalize();
  await db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();

  console.log(`Promoted ${promotions.length} entities to primary_role='crop'.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
