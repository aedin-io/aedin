'use strict';

/**
 * Backfill claims.interaction_type_globi using the heuristic mapping
 * documented in docs/globi-trefle-alignment.md.
 *
 * Mapping uses subject and object bio_category as disambiguation context.
 * Where both are unavailable or inconclusive, we fall back to a default
 * GloBI term per category (eats / pathogenOf / mutualistOf / etc.).
 *
 * Idempotent: safe to re-run. Only writes to rows where the computed
 * mapping differs from the stored value (or the stored value is NULL).
 *
 * Special-case lookups:
 *   - parasitoidOf: triggered when subject is invertebrate AND
 *     primary_role contains 'parasitoid' (more accurate than always
 *     mapping biocontrol-invertebrate-vs-invertebrate to preysOn).
 *
 * Usage: node backend/backfill-globi-interaction-type.js
 */
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = CORPUS_DB;

function pickGlobiTerm(category, subjectBioCat, objectBioCat, subjectRole) {
  switch (category) {
    case 'pollination':
      if (subjectBioCat === 'plantae' && objectBioCat !== 'plantae') return 'pollinatedBy';
      return 'pollinates';

    case 'biocontrol':
      // Subject is the natural enemy. Differentiate by mechanism.
      if (subjectBioCat === 'microbe' || subjectBioCat === 'fungi') return 'pathogenOf';
      // If the predator role is explicitly tagged parasitoid, use that.
      if (subjectRole && /parasitoid/i.test(subjectRole)) return 'parasitoidOf';
      // Otherwise default to predation for invertebrate->invertebrate biocontrol.
      return 'preysOn';

    case 'pest_pressure':
      // Default: pest eats / damages crop. GloBI doesn't have a 'damages' term;
      // 'eats' is the closest direct match.
      return 'eats';

    case 'pathogen_pressure':
      // Microbe/fungus/virus causing disease in plant.
      return 'pathogenOf';

    case 'herbivory':
      return 'eats';

    case 'mutualism':
      return 'mutualistOf';

    case 'parasitism':
      return 'parasiteOf';

    case 'facilitation':
      // No GloBI term for plant-plant facilitation; use the generic.
      return 'interactsWith';

    default:
      return 'interactsWith';
  }
}

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA busy_timeout = 30000');

  const rows = await db.all(`
    SELECT
      c.id, c.interaction_category, c.interaction_type_globi AS current_globi,
      e_s.bio_category AS subject_bio_category,
      e_s.primary_role  AS subject_primary_role,
      e_o.bio_category AS object_bio_category
    FROM claims c
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
    WHERE c.review_status IN ('ai_reviewed', 'human_verified', 'human_rejected', 'disputed')
  `);

  console.log(`[backfill-globi] scanning ${rows.length} reviewed claims`);

  const counts = {};
  let written = 0, unchanged = 0;

  await db.exec('BEGIN');
  try {
    for (const r of rows) {
      const term = pickGlobiTerm(
        r.interaction_category,
        r.subject_bio_category,
        r.object_bio_category,
        r.subject_primary_role
      );
      counts[term] = (counts[term] || 0) + 1;
      if (r.current_globi === term) {
        unchanged++;
      } else {
        await db.run(`UPDATE claims SET interaction_type_globi = ? WHERE id = ?`, [term, r.id]);
        written++;
      }
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  console.log('[backfill-globi] summary:');
  console.log(`  scanned:   ${rows.length}`);
  console.log(`  written:   ${written}`);
  console.log(`  unchanged: ${unchanged}`);
  console.log('  GloBI term distribution:');
  for (const [term, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${(n + '').padStart(5)}  ${term}`);
  }

  await db.close();
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}

module.exports = { pickGlobiTerm };
