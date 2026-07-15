/**
 * reclassify-bio.js
 *
 * Re-derives bio_category for all entities using GBIF taxonomy columns
 * (kingdom, phylum, taxon_class). Run this AFTER sync-gbif.js.
 *
 * For entities without GBIF taxonomy, falls back to family-level heuristics.
 *
 * Usage:
 *   node reclassify-bio.js --dry-run   # preview changes
 *   node reclassify-bio.js             # apply changes
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

// Authoritative classification from GBIF taxonomy
function bioCategoryFromTaxonomy(kingdom, phylum, taxonClass) {
  const k = (kingdom || '').toLowerCase();
  const p = (phylum || '').toLowerCase();
  const c = (taxonClass || '').toLowerCase();

  if (k === 'plantae') return 'plantae';
  if (k === 'fungi') return 'fungi';
  if (k === 'bacteria' || k === 'archaea' || k === 'chromista'
      || k === 'protozoa' || k === 'viruses') return 'microbe';

  if (k === 'animalia') {
    const vertebrateClasses = [
      'mammalia', 'aves', 'reptilia', 'amphibia', 'actinopterygii',
      'chondrichthyes', 'cephalaspidomorphi', 'myxini', 'sarcopterygii'
    ];
    if (vertebrateClasses.includes(c)) return 'vertebrate';
    if (p === 'chordata') return 'vertebrate';
    return 'invertebrate';
  }

  return null; // can't determine
}

// Fallback: classify by family name (known families from GloBI data)
const VERTEBRATE_FAMILIES = new Set([
  'accipitridae', 'alcedinidae', 'anatidae', 'anguillidae', 'bovidae',
  'canidae', 'cervidae', 'charadriidae', 'columbidae', 'corvidae',
  'crocodylidae', 'emydidae', 'erinaceidae', 'falconidae', 'felidae',
  'fringillidae', 'gekkonidae', 'herpestidae', 'hirundinidae', 'iguanidae',
  'lacertidae', 'leporidae', 'muridae', 'mustelidae', 'octopodidae',
  'paridae', 'passeridae', 'phasianidae', 'phyllostomidae', 'picidae',
  'ploceidae', 'procyonidae', 'pycnonotidae', 'rallidae', 'salmonidae',
  'sciuridae', 'strigidae', 'suidae', 'sylviidae', 'troglodytidae',
  'turdidae', 'ursidae', 'vespertilionidae', 'viverridae', 'viperidae',
]);

const FUNGI_FAMILIES = new Set([
  'agaricaceae', 'auriculariaceae', 'boletaceae', 'clavicipitaceae',
  'corticiaceae', 'erysiphaceae', 'hypocreaceae', 'mycosphaerellaceae',
  'nectriaceae', 'ophiocordycipitaceae', 'phragmidiaceae', 'polyporaceae',
  'pucciniaceae', 'pythiaceae', 'russulaceae', 'sclerotiniaceae',
  'tremellaceae', 'tricholomataceae', 'ustilaginaceae',
]);

function bioCategoryFromFamily(family) {
  const f = (family || '').toLowerCase();
  if (!f) return null;

  if (VERTEBRATE_FAMILIES.has(f)) return 'vertebrate';
  if (FUNGI_FAMILIES.has(f)) return 'fungi';

  // Invertebrate family patterns (common suffixes)
  if (f.endsWith('idae') && !VERTEBRATE_FAMILIES.has(f)) {
    // Most -idae families are invertebrate if not in vertebrate set
    // But some are vertebrate — those are in the set above
    return 'invertebrate';
  }

  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  const entities = await db.all(
    'SELECT id, scientific_name, bio_category, kingdom, phylum, taxon_class, family FROM entities WHERE parent_entity_id IS NULL'
  );

  console.log(`=== Bio Category Reclassification ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Total entities: ${entities.length}`);
  console.log('');

  let changed = 0, unchanged = 0, noData = 0;
  const changes = {}; // "old -> new" -> count

  for (const e of entities) {
    // Try GBIF taxonomy first, then family fallback
    let newBio = bioCategoryFromTaxonomy(e.kingdom, e.phylum, e.taxon_class);
    if (!newBio) newBio = bioCategoryFromFamily(e.family);

    if (!newBio) {
      noData++;
      continue;
    }

    if (newBio !== e.bio_category) {
      const key = `${e.bio_category || 'null'} -> ${newBio}`;
      changes[key] = (changes[key] || 0) + 1;

      if (!dryRun) {
        await db.run('UPDATE entities SET bio_category = ?, updated_at = datetime(?) WHERE id = ?',
          [newBio, new Date().toISOString(), e.id]);
      }
      changed++;
    } else {
      unchanged++;
    }
  }

  console.log(`Changed:   ${changed}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`No data:   ${noData} (no kingdom or family to classify from)`);

  if (Object.keys(changes).length) {
    console.log('\nReclassification breakdown:');
    const sorted = Object.entries(changes).sort((a, b) => b[1] - a[1]);
    for (const [transition, count] of sorted) {
      console.log(`  ${transition}: ${count}`);
    }
  }

  // Show final breakdown
  if (!dryRun) {
    const stats = await db.all('SELECT bio_category, COUNT(*) as n FROM entities GROUP BY bio_category ORDER BY n DESC');
    console.log('\nFinal bio_category breakdown:');
    for (const s of stats) console.log(`  ${s.bio_category}: ${s.n}`);
  }

  await db.close();
  console.log('\nDone.');
}

main().catch(err => { console.error('Reclassification failed:', err); process.exit(1); });
