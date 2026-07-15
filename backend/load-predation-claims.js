/**
 * load-predation-claims.js
 *
 * Incremental loader that processes only predation/parasitism interactions
 * into the claims table. Designed to run after fetch-globi-predation.js
 * adds new records to the interactions table.
 *
 * Unlike load-globi-claims.js --force (which rebuilds ALL claims from scratch),
 * this only processes interaction types relevant to biocontrol chains and
 * skips claims that already exist.
 *
 * Usage:
 *   node load-predation-claims.js            # load new predation claims
 *   node load-predation-claims.js --dry-run  # preview without inserting
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const DRY_RUN = process.argv.includes('--dry-run');

const ANIMAL_CATEGORIES = new Set(['invertebrate', 'vertebrate']);
const PEST_CATEGORIES = new Set(['invertebrate', 'fungi', 'microbe']);

const GENBANK_RE = /^[A-Z]{2}\d{6}/;
function isGarbage(name) {
  if (!name || typeof name !== 'string') return true;
  if (GENBANK_RE.test(name)) return true;
  if (!/[a-zA-Z]/.test(name)) return true;
  if (name.includes('|')) return true;
  if (/^[a-z]/.test(name)) return true;
  if (name.includes('http')) return true;
  if (/^\d/.test(name)) return true;
  if (name.startsWith('?')) return true;
  if (name.length > 80 && !/ var\. | subsp\. /.test(name)) return true;
  if (!name.includes(' ')) return true;
  if (/\bsp\.?$/.test(name) && !/f\. sp\./.test(name)) return true;
  if (/\bsp\.? [A-Z0-9]/.test(name) && !/f\. sp\./.test(name) && !/ subsp\. /.test(name)) return true;
  if (/ nr\. | nr | cf\. | cf /.test(name)) return true;
  if (/^[.<'"&(+\-]/.test(name)) return true;
  if (/^[A-Z]\. /.test(name)) return true;
  return false;
}

function resolveInteraction(itype, srcBio, tgtBio) {
  const srcIsAnimal = ANIMAL_CATEGORIES.has(srcBio);
  const tgtIsAnimal = ANIMAL_CATEGORIES.has(tgtBio);
  const tgtIsPlant = tgtBio === 'plantae';
  const tgtIsPestCategory = PEST_CATEGORIES.has(tgtBio);

  switch (itype) {
    case 'preysOn': case 'kills':
      if (srcIsAnimal && tgtIsPestCategory)
        return { category: 'biocontrol', effect: 'beneficial', weight: 2.5 };
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 2.5 };
      if (srcBio === 'invertebrate' && tgtIsPlant)
        return { category: 'herbivory', effect: 'harmful', weight: -2.0 };
      return { category: 'facilitation', effect: 'neutral', weight: 0 };

    case 'parasitoidOf':
      if (tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 3.0 };
      return { category: 'parasitism', effect: 'harmful', weight: -2.0 };

    case 'parasiteOf':
      if (srcBio === 'invertebrate' && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 2.5 };
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 3.0 };
      return { category: 'parasitism', effect: 'harmful', weight: -2.0 };

    case 'pathogenOf':
      if ((srcBio === 'fungi' || srcBio === 'microbe') && tgtBio === 'invertebrate')
        return { category: 'biocontrol', effect: 'beneficial', weight: 3.0 };
      return { category: 'pathogen_pressure', effect: 'harmful', weight: -2.0 };

    default:
      return { category: 'facilitation', effect: 'neutral', weight: 0 };
  }
}

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(ATTACH_RAW_SQL);
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 30000;
    PRAGMA cache_size = -65536;
    PRAGMA temp_store = MEMORY;
  `);

  // Load entity lookup
  console.log('Building entity lookup...');
  const entityRows = await db.all(
    'SELECT id, scientific_name, bio_category FROM entities'
  );
  const entityMap = new Map();
  for (const e of entityRows) {
    entityMap.set(e.scientific_name.toLowerCase(), e);
  }
  console.log(`  ${entityMap.size} entities loaded.`);

  // Load existing claims to deduplicate
  console.log('Loading existing claim keys...');
  const existingClaims = new Set();
  const claimRows = await db.all(`
    SELECT subject_entity_id, object_entity_id, interaction_type_raw
    FROM claims
    WHERE interaction_type_raw IN ('preysOn', 'parasiteOf', 'parasitoidOf', 'kills', 'pathogenOf')
  `);
  for (const c of claimRows) {
    existingClaims.add(`${c.subject_entity_id}||${c.object_entity_id}||${c.interaction_type_raw}`);
  }
  console.log(`  ${existingClaims.size} existing predation claims.\n`);

  // Query deduplicated predation interactions
  console.log('Loading predation interactions...');
  const triples = await db.all(`
    SELECT source_name, target_name, interaction_type, COUNT(*) as cnt
    FROM raw.interactions
    WHERE interaction_type IN ('preysOn', 'parasiteOf', 'parasitoidOf', 'kills', 'pathogenOf')
    GROUP BY source_name, target_name, interaction_type
  `);
  console.log(`  ${triples.length} unique predation triples to process.\n`);

  const stmt = DRY_RUN ? null : await db.prepare(`
    INSERT INTO claims (
      subject_entity_id, object_entity_id, data_tier,
      interaction_type_raw, interaction_category, effect_direction,
      confidence_score, applied_weight, evidence_tier,
      valence_confidence, resolution_path,
      mechanism, impact_class,
      interaction_count, locality_count,
      country, subdivision
    ) VALUES (?, ?, 'tier2_globi', ?, ?, ?, 0.5, ?, 'inferred', 'resolved', ?, 'biological_control', 'weighted', ?, 0, '', '')
  `);

  let inserted = 0;
  let skipped = 0;
  let noEntity = 0;
  let garbage = 0;
  let duplicate = 0;

  if (!DRY_RUN) await db.run('BEGIN TRANSACTION');

  for (const triple of triples) {
    if (isGarbage(triple.source_name) || isGarbage(triple.target_name)) {
      garbage++;
      continue;
    }

    const src = entityMap.get(triple.source_name.toLowerCase());
    const tgt = entityMap.get(triple.target_name.toLowerCase());

    if (!src || !tgt) {
      noEntity++;
      continue;
    }

    const key = `${src.id}||${tgt.id}||${triple.interaction_type}`;
    if (existingClaims.has(key)) {
      duplicate++;
      continue;
    }
    existingClaims.add(key);

    const resolved = resolveInteraction(
      triple.interaction_type,
      (src.bio_category || '').toLowerCase(),
      (tgt.bio_category || '').toLowerCase()
    );

    if (!DRY_RUN) {
      await stmt.run([
        src.id, tgt.id,
        triple.interaction_type, resolved.category, resolved.effect,
        resolved.weight,
        `${(src.bio_category || '')} ${triple.interaction_type} ${(tgt.bio_category || '')} → ${resolved.category}`,
        triple.cnt
      ]);
    }
    inserted++;
  }

  if (!DRY_RUN) {
    await db.run('COMMIT');
    if (stmt) await stmt.finalize();
  }

  console.log(`=== Results (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`New claims inserted: ${inserted}`);
  console.log(`Duplicates skipped: ${duplicate}`);
  console.log(`No matching entity: ${noEntity}`);
  console.log(`Garbage names filtered: ${garbage}`);

  if (!DRY_RUN && inserted > 0) {
    // Show biocontrol claim stats
    const bcStats = await db.get(`
      SELECT COUNT(*) as n FROM claims WHERE interaction_category = 'biocontrol'
    `);
    console.log(`\nTotal biocontrol claims now: ${bcStats.n}`);
  }

  await db.close();
  console.log('Done.');
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
