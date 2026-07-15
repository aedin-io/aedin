#!/usr/bin/env node
'use strict';

/**
 * detect-taxonomy-corruption.js — READ-ONLY report of entities whose stored
 * phylum/kingdom contradicts a curated genus signal (GBIF genus-name collisions:
 * Ficus→Mollusca, Cyathus→Arthropoda, Uredo→Tracheophyta). See lib/phylum-validator.js.
 *
 * Mutates NOTHING. Produces the candidate list + confidence buckets for the heavy
 * GBIF re-resolution pass (which will run under the heavy-job-safety harness and be
 * agroecologist-gated). The point of this pass is to QUANTIFY the corruption and to
 * validate the detector's precision before trusting it to drive any mutation.
 *
 * Confidence buckets (inversion contract — context CONFIRMS, never creates):
 *   strong  — genus is curated fungal/bacterial (name is high-confidence on its own),
 *             OR a plant-genus candidate that ALSO has a plantae-only trait claim,
 *             AND the row carries no animal-role claim. Very likely real corruption.
 *   review  — plant-genus candidate with no confirming context either way. Needs a
 *             per-row look (could be the legit animal namesake).
 *   likely_false — candidate that has an animal-role claim (herbivore/predator/etc.):
 *             probably the real animal namesake; the stored animal phylum may be right.
 *
 * Usage: node detect-taxonomy-corruption.js [--limit-samples=20]
 */

const { CORPUS_DB } = require('./lib/db-paths.cjs');
const Database = require('better-sqlite3');
const { detectCorruptionCandidate } = require('./lib/phylum-validator');
const { plantTraitEntityIds, animalContextEntityIds } = require('./lib/kingdom-hint');

const SAMPLES = parseInt((process.argv.find(a => a.startsWith('--limit-samples=')) || '').split('=')[1], 10) || 20;
const DB_PATH = CORPUS_DB;

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const plantSet = plantTraitEntityIds(db);
  const animalSet = animalContextEntityIds(db);

  const buckets = { strong: [], review: [], likely_false: [] };
  const bucketCounts = { strong: 0, review: 0, likely_false: 0 };
  const byTransition = {};   // "plantae→animal" → count

  // Stream entities with a stored phylum; never materialize the whole table.
  // scope_tier is the served signal (non-NULL → has / will have a D1 page).
  const hasScopeTier = db.prepare("PRAGMA table_info(entities)").all().some(c => c.name === 'scope_tier');
  const scopeSel = hasScopeTier ? 'scope_tier' : 'NULL AS scope_tier';
  const stmt = db.prepare(
    `SELECT id, scientific_name, common_name, genus, kingdom, phylum, ${scopeSel}
       FROM entities
      WHERE phylum IS NOT NULL AND phylum != ''`
  );
  let scanned = 0;
  for (const e of stmt.iterate()) {
    scanned++;
    const cand = detectCorruptionCandidate(e);
    if (!cand) continue;

    const key = `${cand.expectedKingdom}→${cand.storedKingdom}`;
    byTransition[key] = (byTransition[key] || 0) + 1;

    const hasPlantTrait = plantSet.has(e.id);
    const hasAnimalRole = animalSet.has(e.id);
    const nameIsMicrobial = cand.expectedKingdom === 'fungi' || cand.expectedKingdom === 'bacteria';

    let bucket;
    if (hasAnimalRole && cand.storedKingdom === 'animal') bucket = 'likely_false';
    else if (nameIsMicrobial || hasPlantTrait) bucket = 'strong';
    else bucket = 'review';
    bucketCounts[bucket]++;

    if (buckets[bucket].length < SAMPLES) {
      buckets[bucket].push(
        `#${e.id} ${e.scientific_name} (${e.common_name || 'no common name'}) ` +
        `kingdom=${e.kingdom || 'NULL'} phylum=${e.phylum} [${key}] ` +
        `served=${e.scope_tier != null ? 'Y(tier' + e.scope_tier + ')' : 'n'}`
      );
    }
  }

  console.log(`\n[detect-taxonomy-corruption] READ-ONLY — scanned ${scanned} entities with a stored phylum.\n`);
  console.log('Candidate transitions (expected-kingdom → stored-kingdom):');
  for (const [k, v] of Object.entries(byTransition).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  const totalCandidates = Object.values(byTransition).reduce((a, b) => a + b, 0);
  console.log(`  ${'TOTAL'.padEnd(20)} ${totalCandidates}\n`);

  console.log('Confidence buckets (true counts):');
  for (const name of ['strong', 'review', 'likely_false']) {
    console.log(`  ${name.padEnd(14)} ${bucketCounts[name]}`);
  }
  console.log('');

  for (const name of ['strong', 'review', 'likely_false']) {
    console.log(`── ${name} (showing up to ${SAMPLES}) ──`);
    if (!buckets[name].length) console.log('  (none)');
    for (const line of buckets[name]) console.log(`  ${line}`);
    console.log('');
  }

  db.close();
}

main();
