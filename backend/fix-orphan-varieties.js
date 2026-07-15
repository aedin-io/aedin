'use strict';
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Find distinct species that have orphaned varieties
  const orphanSpecies = await db.all(`
    SELECT DISTINCT SUBSTR(v.scientific_name, 1, INSTR(v.scientific_name, ' ''') - 1) as species_name,
      v.parent_entity_id as old_parent_id
    FROM entities v
    WHERE v.parent_entity_id IS NOT NULL
      AND v.parent_entity_id NOT IN (SELECT id FROM entities WHERE parent_entity_id IS NULL)
  `);

  console.log(`Found ${orphanSpecies.length} species with orphaned varieties.`);

  let created = 0, relinked = 0;
  for (const sp of orphanSpecies) {
    // Create the parent entity if it doesn't exist
    await db.run(`
      INSERT OR IGNORE INTO entities (scientific_name, bio_category, primary_role, source_table, data_completeness, created_at, updated_at)
      VALUES (?, 'plantae', 'crop', 'extension_scrape', 'minimal', datetime('now'), datetime('now'))
    `, [sp.species_name]);

    const parent = await db.get('SELECT id FROM entities WHERE scientific_name = ? AND parent_entity_id IS NULL', [sp.species_name]);
    if (!parent) {
      console.log(`  Failed to create: ${sp.species_name}`);
      continue;
    }
    created++;

    // Relink orphaned varieties to new parent
    const result = await db.run('UPDATE entities SET parent_entity_id = ? WHERE parent_entity_id = ?', [parent.id, sp.old_parent_id]);
    relinked += result.changes;
    console.log(`  ${sp.species_name}: id=${parent.id}, relinked ${result.changes} varieties`);
  }

  console.log(`\nCreated ${created} parent entities, relinked ${relinked} varieties`);

  // Verify
  const check = await db.all(`
    SELECT e.scientific_name, COUNT(*) as cnt
    FROM entities v JOIN entities e ON v.parent_entity_id = e.id
    WHERE v.parent_entity_id IS NOT NULL
    GROUP BY v.parent_entity_id ORDER BY cnt DESC
  `);
  console.log('\nParents with varieties:');
  for (const r of check) console.log(`  ${r.scientific_name}: ${r.cnt}`);

  await db.close();
  console.log('Done.');
}

main().catch(err => { console.error('Fix failed:', err); process.exit(1); });
