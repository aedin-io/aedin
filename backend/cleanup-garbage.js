/**
 * cleanup-garbage.js
 *
 * Removes non-organism entries from the entities table:
 *   - Specimen/catalog IDs (pipe-delimited strings)
 *   - Habitat descriptions (lowercase start: "a south facing slope")
 *   - Entries with UUIDs or URLs
 *   - Very long non-scientific strings (>80 chars without valid taxonomy)
 *   - Indeterminate species ("sp.", "sp. A", "sp 123", "?genus")
 *   - Regional field codes ("(Sulawesi) sp. 1")
 *   - Uncertain identifications ("cf.", "nr.")
 *
 * Additional patterns (round 2):
 *   - Quoted habitat descriptions ("Live Oak" trees, "black earth")
 *   - Ampersand-prefixed ("& Arenaria", "& along dam of lake")
 *   - +/- substrate notes ("+/- basic sandstone")
 *   - Parenthesized descriptions at start ("(white) clay savanna")
 *   - Starts with punctuation (period, angle bracket, apostrophe)
 *   - Abbreviated genus ("A. scoparius", "B. napus") — single letter + dot + space
 *   - Ends with period (sentences, not species names)
 *
 * Preserves: forma specialis (f. sp.), pro sp. notation, real genera like Typhula
 *
 * Also deletes claims referencing garbage entities.
 *
 * Usage:
 *   node cleanup-garbage.js --dry-run   # preview
 *   node cleanup-garbage.js             # delete
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Build garbage detection query
  // Each condition catches a distinct pattern of non-scientific-name entries
  const garbageWhere = `
    parent_entity_id IS NULL AND (
      -- Original garbage patterns
      scientific_name LIKE '%|%'
      OR scientific_name GLOB '[a-z]*'
      OR scientific_name LIKE '%http%'
      OR scientific_name LIKE '%uuid%'
      OR scientific_name GLOB '*[0-9][0-9][0-9][0-9][0-9]*'
      OR (LENGTH(scientific_name) > 80 AND scientific_name NOT LIKE '% var. %' AND scientific_name NOT LIKE '% subsp. %')

      -- Indeterminate species: "Genus sp." or "Genus sp" at end of name
      -- But NOT "f. sp." (forma specialis) which is a valid taxonomic rank
      OR (
        (scientific_name LIKE '% sp.' OR scientific_name LIKE '% sp')
        AND scientific_name NOT LIKE '%f. sp.%'
        AND scientific_name NOT LIKE '%(pro%sp.)%'
      )

      -- Lettered/numbered indeterminate: "Genus sp. A", "Genus sp 123"
      -- But NOT "f. sp." entries
      OR (
        (scientific_name LIKE '% sp. %' OR scientific_name LIKE '% sp %')
        AND scientific_name NOT LIKE '%f. sp.%'
        AND scientific_name NOT LIKE '%(pro%sp.)%'
        AND scientific_name NOT LIKE '% subsp. %'
      )

      -- Unknown organisms: starts with ?
      OR scientific_name LIKE '?%'

      -- Starts with a number (common names, habitat descriptions)
      OR scientific_name GLOB '[0-9]*'

      -- Regional field codes with parenthetical location
      OR scientific_name LIKE '%(Sulawesi)%'

      -- Uncertain identifications
      OR (scientific_name LIKE '% nr. %' OR scientific_name LIKE '% nr %')
      OR (scientific_name LIKE '% cf. %' OR scientific_name LIKE '% cf %')

      -- Round 2: habitat/substrate descriptions and non-taxonomic entries

      -- Quoted descriptions: "Live Oak" trees, "black earth", "red" soil
      OR scientific_name LIKE '"%'

      -- Ampersand-prefixed: & Arenaria, & along dam of lake
      OR scientific_name LIKE '&%'

      -- +/- substrate notes: +/- basic sandstone, +/- sound wood
      OR scientific_name LIKE '+/-%'

      -- Parenthesized start: (white) clay savanna, (not glaciated) sandstone
      -- But NOT (Platyrrhinus) which is a valid synonym notation
      OR (scientific_name LIKE '(%' AND scientific_name NOT GLOB '([A-Z][a-z]*)[A-Z]*')

      -- Starts with period: . P. nodosus
      OR scientific_name LIKE '.%'

      -- Starts with angle bracket: <tufts> at edge of stream
      OR scientific_name LIKE '<%'

      -- Starts with apostrophe/single quote: 'os taludes, 'steps'
      OR scientific_name LIKE '''%'

      -- Abbreviated genus: "A. scoparius", "B. napus" — single uppercase letter + period + space
      -- These are incomplete references, not valid scientific names
      OR scientific_name GLOB '[A-Z]. *'

      -- Single word in all caps (acronyms, codes)
      OR (scientific_name NOT LIKE '% %' AND scientific_name GLOB '[A-Z][A-Z]*')
    )
  `;

  // Preview
  const garbageCount = await db.get(`SELECT COUNT(*) as c FROM entities WHERE ${garbageWhere}`);
  const claimsCount = await db.get(`SELECT COUNT(*) as c FROM claims WHERE subject_entity_id IN (SELECT id FROM entities WHERE ${garbageWhere}) OR object_entity_id IN (SELECT id FROM entities WHERE ${garbageWhere})`);

  const samples = await db.all(`SELECT scientific_name, bio_category, source_table FROM entities WHERE ${garbageWhere} ORDER BY RANDOM() LIMIT 20`);

  const totalEntities = await db.get('SELECT COUNT(*) as c FROM entities');
  const totalClaims = await db.get('SELECT COUNT(*) as c FROM claims');

  console.log('=== Garbage Cleanup ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');
  console.log(`Garbage entities: ${garbageCount.c} (of ${totalEntities.c} total)`);
  console.log(`Claims to remove: ${claimsCount.c} (of ${totalClaims.c} total)`);
  console.log('');
  console.log('Sample garbage:');
  for (const s of samples) {
    console.log(`  [${s.bio_category}] ${s.scientific_name.slice(0, 80)}`);
  }

  if (dryRun) {
    console.log('\nRun without --dry-run to execute.');
    await db.close();
    return;
  }

  console.log('\nDeleting claims referencing garbage entities...');
  const claimResult = await db.run(`DELETE FROM claims WHERE subject_entity_id IN (SELECT id FROM entities WHERE ${garbageWhere}) OR object_entity_id IN (SELECT id FROM entities WHERE ${garbageWhere})`);
  console.log(`  Deleted ${claimResult.changes} claims.`);

  console.log('Deleting garbage entities...');
  const entityResult = await db.run(`DELETE FROM entities WHERE ${garbageWhere}`);
  console.log(`  Deleted ${entityResult.changes} entities.`);

  const remaining = await db.get('SELECT COUNT(*) as c FROM entities');
  const remainingClaims = await db.get('SELECT COUNT(*) as c FROM claims');
  console.log('');
  console.log('After cleanup:');
  console.log(`  Entities: ${remaining.c}`);
  console.log(`  Claims:   ${remainingClaims.c}`);

  await db.close();
  console.log('Done.');
}

main().catch(err => { console.error('Cleanup failed:', err); process.exit(1); });
