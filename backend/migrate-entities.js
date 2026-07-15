// backend/migrate-entities.js
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

// Prevent sqlite3 driver's unhandled error events from crashing the process
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('SQLITE_CORRUPT')) {
    console.warn('  [skip] corrupt row:', err.message.slice(0, 80));
  } else {
    console.error('Uncaught exception:', err);
    process.exit(1);
  }
});

const DB_PATH = CORPUS_DB;

// GenBank accession pattern and garbage filter
const GARBAGE_RE = /^[A-Z]{2}\d{6}/;
function isGarbage(name) {
  if (!name) return true;
  if (GARBAGE_RE.test(name)) return true;
  if (!/[a-zA-Z]/.test(name)) return true;
  return false;
}

// Map planner_organisms.primary_role -> entities.primary_role + bio_category + organism_type
function classifyOrganism(o, verifiedCropNames) {
  const role = (o.primary_role || 'neutral').toLowerCase();
  const family = (o.family || '').toLowerCase();
  const sciName = (o.scientific_name || '').toLowerCase();

  let primaryRole = 'unclassified';
  let bioCategory = 'plantae';
  let organismType = null;

  if (role === 'crop') {
    primaryRole = 'crop';
    bioCategory = 'plantae';
  } else if (role === 'weed') {
    if (verifiedCropNames.has(sciName)) {
      primaryRole = 'crop';
    } else if (o.is_legume === 1 || family === 'fabaceae') {
      primaryRole = 'wild_plant';
    } else {
      primaryRole = 'weed';
    }
    bioCategory = 'plantae';
  } else if (role === 'pest_insect') {
    primaryRole = 'pest';
    bioCategory = 'invertebrate';
    organismType = 'insect';
  } else if (role === 'pest_mite') {
    primaryRole = 'pest';
    bioCategory = 'invertebrate';
    organismType = 'mite';
  } else if (role === 'pathogen_fungal') {
    primaryRole = 'pathogen';
    bioCategory = 'fungi';
    organismType = 'fungus';
  } else if (role === 'pathogen_bacterial') {
    primaryRole = 'pathogen';
    bioCategory = 'microbe';
    organismType = 'bacterium';
  } else if (role === 'pathogen_viral') {
    primaryRole = 'pathogen';
    bioCategory = 'microbe';
    organismType = 'virus';
  } else if (role === 'pathogen_nematode') {
    primaryRole = 'pathogen';
    bioCategory = 'invertebrate';
    organismType = 'nematode';
  } else if (role === 'beneficial_predator') {
    primaryRole = 'predator';
    bioCategory = 'invertebrate';
  } else if (role === 'beneficial_parasitoid') {
    primaryRole = 'parasitoid';
    bioCategory = 'invertebrate';
  } else if (role === 'pollinator') {
    primaryRole = 'pollinator';
    bioCategory = 'invertebrate';
  } else if (role === 'soil_microbe') {
    primaryRole = 'soil_organism';
    bioCategory = 'microbe';
  } else if (role === 'neutral') {
    const tp = (o.taxon_path || '').toLowerCase();
    if (tp.includes('plantae') || tp.includes('magnoliopsida') || tp.includes('liliopsida')) {
      primaryRole = 'wild_plant';
      bioCategory = 'plantae';
    } else if (tp.includes('insecta') || tp.includes('arachnida')) {
      primaryRole = 'unclassified';
      bioCategory = 'invertebrate';
    } else if (tp.includes('fungi')) {
      primaryRole = 'unclassified';
      bioCategory = 'fungi';
    } else {
      primaryRole = 'unclassified';
      bioCategory = 'plantae';
    }
  } else {
    primaryRole = 'unclassified';
  }

  return { primaryRole, bioCategory, organismType };
}

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL;');

  // Ensure entities table exists
  const migration008 = require('./migrations/008_entities_table');
  await migration008.runMigration(db);

  // Incremental: INSERT OR IGNORE handles dedup. --force clears and re-migrates.
  const existing = await db.get('SELECT count(*) as c FROM entities');
  if (process.argv.includes('--force')) {
    console.log(`--force: clearing ${existing.c} entities and re-migrating...`);
    await db.run('DELETE FROM entities');
  } else if (existing.c > 0) {
    console.log(`entities table has ${existing.c} rows. Running incremental (new organisms only)...`);
  }

  // Load verified_crops names for reclassification
  const verifiedCropNames = new Set();
  try {
    const vcRows = await db.all('SELECT scientific_name FROM verified_crops');
    for (const r of vcRows) {
      if (r.scientific_name) verifiedCropNames.add(r.scientific_name.toLowerCase());
    }
    console.log(`Loaded ${verifiedCropNames.size} verified crop names for reclassification.`);
  } catch (e) {
    console.warn('Could not load verified_crops (table may not exist):', e.message);
  }

  // Step 1: Get all IDs from planner_organisms (no ORDER BY to avoid corruption)
  console.log('Fetching planner_organisms IDs...');
  let allIds;
  try {
    allIds = await db.all('SELECT id FROM planner_organisms');
  } catch (e) {
    if (e.message.includes('no such table')) {
      console.log('planner_organisms table not found (already migrated and dropped).');
      console.log(`Entities table has ${existing.c} rows. Nothing to migrate.`);
      await db.close();
      return;
    }
    console.error('Failed to fetch IDs:', e.message);
    await db.close();
    return;
  }
  console.log(`Found ${allIds.length} planner_organisms IDs.`);

  // Step 2: Hydrate and insert row-by-row
  const insert = await db.prepare(`
    INSERT OR IGNORE INTO entities (
      scientific_name, common_name, family, genus, taxonomy_path,
      bio_category, primary_role, organism_type, pest_mobility,
      data_completeness, source_table
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'minimal', 'planner_organisms')
  `);

  let migrated = 0;
  let skippedCorrupt = 0;
  let skippedGarbage = 0;
  let reclassifiedWeed = 0;
  const batchSize = 500;

  for (let i = 0; i < allIds.length; i++) {
    if (i % batchSize === 0 && i > 0) {
      console.log(`  ... processed ${i}/${allIds.length} (migrated: ${migrated}, corrupt: ${skippedCorrupt}, garbage: ${skippedGarbage})`);
    }

    const rowId = allIds[i].id;
    let o;
    try {
      o = await db.get(
        `SELECT id, scientific_name, common_name, family, primary_role,
                is_legume, is_brassica, is_allium, taxon_path,
                pest_mobility, created_at
         FROM planner_organisms WHERE id = ?`,
        rowId
      );
    } catch (e) {
      skippedCorrupt++;
      continue;
    }

    if (!o || isGarbage(o.scientific_name)) {
      skippedGarbage++;
      continue;
    }

    const { primaryRole, bioCategory, organismType } = classifyOrganism(o, verifiedCropNames);

    if ((o.primary_role || '').toLowerCase() === 'weed' && primaryRole !== 'weed') {
      reclassifiedWeed++;
    }

    const genus = o.scientific_name.split(' ')[0] || null;

    try {
      await insert.run(
        o.scientific_name,
        o.common_name || null,
        o.family || null,
        genus,
        o.taxon_path || null,
        bioCategory,
        primaryRole,
        organismType,
        o.pest_mobility || null
      );
      migrated++;
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        // Duplicate scientific_name — skip silently
      } else {
        console.warn(`  [warn] insert failed for ${o.scientific_name}:`, e.message);
      }
    }
  }

  await insert.finalize();

  console.log('\n=== Migration Summary ===');
  console.log(`Total planner_organisms IDs: ${allIds.length}`);
  console.log(`Migrated to entities:        ${migrated}`);
  console.log(`Skipped (corrupt):           ${skippedCorrupt}`);
  console.log(`Skipped (garbage):           ${skippedGarbage}`);
  console.log(`Reclassified weed -> other:  ${reclassifiedWeed}`);

  // Print role distribution
  const roles = await db.all('SELECT primary_role, count(*) as c FROM entities GROUP BY primary_role ORDER BY c DESC');
  console.log('\nRole distribution:');
  for (const r of roles) {
    console.log(`  ${r.primary_role}: ${r.c}`);
  }

  await db.close();
  console.log('\nDone.');
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });
