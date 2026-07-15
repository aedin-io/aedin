/**
 * cleanup-genus.js
 *
 * Removes genus-level entities (single-word scientific names like "Solanum")
 * and any claims that reference them. These entries can't be enriched from
 * Trefle/GBIF/Wikidata and add noise to the dataset.
 *
 * Usage:
 *   node cleanup-genus.js --dry-run   # preview what would be deleted
 *   node cleanup-genus.js             # actually delete
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Genus-level = no space in scientific_name
  const genusCount = await db.get("SELECT COUNT(*) as c FROM entities WHERE scientific_name NOT LIKE '% %'");
  const speciesCount = await db.get("SELECT COUNT(*) as c FROM entities WHERE scientific_name LIKE '% %'");

  const claimsSubject = await db.get("SELECT COUNT(*) as c FROM claims WHERE subject_entity_id IN (SELECT id FROM entities WHERE scientific_name NOT LIKE '% %')");
  const claimsObject = await db.get("SELECT COUNT(*) as c FROM claims WHERE object_entity_id IN (SELECT id FROM entities WHERE scientific_name NOT LIKE '% %')");
  const claimsEither = await db.get("SELECT COUNT(*) as c FROM claims WHERE subject_entity_id IN (SELECT id FROM entities WHERE scientific_name NOT LIKE '% %') OR object_entity_id IN (SELECT id FROM entities WHERE scientific_name NOT LIKE '% %')");
  const totalClaims = await db.get('SELECT COUNT(*) as c FROM claims');

  console.log('=== Genus Cleanup ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log('');
  console.log('Entities:');
  console.log(`  Genus-level to remove: ${genusCount.c}`);
  console.log(`  Species-level to keep: ${speciesCount.c}`);
  console.log('');
  console.log('Claims:');
  console.log(`  Total: ${totalClaims.c}`);
  console.log(`  Referencing genus (either side): ${claimsEither.c}`);
  console.log(`  Will remain: ${totalClaims.c - claimsEither.c}`);
  console.log('');

  if (dryRun) {
    console.log('Run without --dry-run to execute.');
    await db.close();
    return;
  }

  console.log('Deleting claims referencing genus-level entities...');
  const claimResult = await db.run(
    "DELETE FROM claims WHERE subject_entity_id IN (SELECT id FROM entities WHERE scientific_name NOT LIKE '% %') OR object_entity_id IN (SELECT id FROM entities WHERE scientific_name NOT LIKE '% %')"
  );
  console.log(`  Deleted ${claimResult.changes} claims.`);

  console.log('Deleting genus-level entities...');
  const entityResult = await db.run("DELETE FROM entities WHERE scientific_name NOT LIKE '% %'");
  console.log(`  Deleted ${entityResult.changes} entities.`);

  // Verify
  const remaining = await db.get('SELECT COUNT(*) as c FROM entities');
  const remainingClaims = await db.get('SELECT COUNT(*) as c FROM claims');
  console.log('');
  console.log('After cleanup:');
  console.log(`  Entities: ${remaining.c}`);
  console.log(`  Claims: ${remainingClaims.c}`);

  await db.close();
  console.log('Done.');
}

main().catch(err => { console.error('Cleanup failed:', err); process.exit(1); });
