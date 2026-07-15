'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  const varieties = await db.all('SELECT * FROM crop_varieties');
  console.log(`Found ${varieties.length} crop_varieties to migrate.`);
  if (varieties.length === 0) { await db.close(); return; }

  // Build parent lookup: species_name -> entity id
  const parents = await db.all("SELECT id, scientific_name FROM entities WHERE parent_entity_id IS NULL");
  const parentMap = {};
  for (const p of parents) {
    parentMap[p.scientific_name.toLowerCase()] = p.id;
  }

  let migrated = 0, skipped = 0, noParent = 0;

  for (const v of varieties) {
    const parentId = parentMap[(v.species_name || '').toLowerCase()];
    if (!parentId) {
      if (noParent < 5) console.log(`  [no parent] ${v.species_name} / ${v.variety_name}`);
      noParent++;
      continue;
    }

    // Normalize variety name
    const varietyName = (v.variety_name || '').trim()
      .replace(/[™®]/g, '')
      .replace(/'/g, '\u2019')
      .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

    if (!varietyName) { skipped++; continue; }

    // Check if already migrated
    const existing = await db.get(
      'SELECT id FROM entities WHERE parent_entity_id = ? AND variety_name = ?',
      [parentId, varietyName]
    );
    if (existing) { skipped++; continue; }

    // Parse traits_json for any structured data
    let traits = {};
    try { traits = v.traits_json ? JSON.parse(v.traits_json) : {}; } catch (e) { /* ignore */ }

    if (!dryRun) {
      // scientific_name must be UNIQUE; use "Species name 'Variety'" convention
      const scientificNameVariety = `${v.species_name} '${varietyName}'`;
      await db.run(`
        INSERT INTO entities (
          scientific_name, common_name, variety_name, parent_entity_id,
          bio_category, primary_role, source_table, data_completeness,
          native_regions, days_to_harvest,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'plantae', 'crop', 'extension_scrape', 'minimal',
                  ?, ?, datetime('now'), datetime('now'))
      `, [
        scientificNameVariety,
        varietyName,  // Use variety name as common_name too
        varietyName,
        parentId,
        v.region ? JSON.stringify([v.region]) : null,
        v.maturity_days || null,
      ]);
    }

    migrated++;
  }

  console.log(`\n=== Variety Migration Summary ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Total crop_varieties: ${varieties.length}`);
  console.log(`Migrated: ${migrated}`);
  console.log(`Skipped (duplicate/empty): ${skipped}`);
  console.log(`No parent found: ${noParent}`);

  if (!dryRun && migrated > 0) {
    const count = await db.get('SELECT COUNT(*) as c FROM entities WHERE parent_entity_id IS NOT NULL');
    console.log(`\nTotal variety entities: ${count.c}`);
  }

  await db.close();
  console.log('Done.');
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });
