#!/usr/bin/env node
'use strict';
/**
 * fix-animal-kingdom-backfill.js — backfill kingdom='Animalia' for the GENUINE animals among the
 * remaining animal-tagged + NULL-kingdom entities (post fungal-genus fix). bio_category is already
 * invertebrate/vertebrate for these; this only completes the kingdom field.
 *
 * SAFETY (kingdom backfill can HIDE corruption by making a mis-tagged non-animal consistent-wrong):
 *  - skip genera in FUNGAL_GENERA (curated fungus) and EXCLUDE_GENERA (known dual-kingdom namesakes:
 *    the held-back ambiguous fungi + orchid/liverwort/plant collisions)
 *  - DATA GUARD: skip any genus that ALSO appears as a confirmed non-animal entity (bio_category
 *    plantae/fungi/microbe OR kingdom Plantae/Fungi/Bacteria) anywhere in the DB
 * Everything skipped stays flagged needs_taxonomy_review for manual review. revision_log-logged.
 * Dry-run by default.
 *
 * Usage: node fix-animal-kingdom-backfill.js [--apply]
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { FUNGAL_GENERA } = require('./lib/curated-genera');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const APPLY = process.argv.includes('--apply');
const genusOf = (name) => name.replace(/^\[/, '').split(/[\s(]/)[0].toLowerCase();

// Known dual-kingdom namesakes among the suspects — held for manual review, never auto-stamped animal.
const EXCLUDE_GENERA = new Set([
  'asterina', 'caryospora', 'sphaerella', 'fenestella', 'flammula', // ambiguous fungi
  'satyrium', 'stelis', 'pachyglossa', 'langsdorfia', 'plagiochomuus', 'fasta', // plant/orchid/uncertain
]);

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const rows = await db.all(
    `SELECT id, scientific_name, bio_category FROM entities
     WHERE bio_category IN ('invertebrate','vertebrate') AND (kingdom IS NULL OR kingdom='')
     ORDER BY scientific_name`
  );

  const nonAnimalCache = new Map();
  async function hasNonAnimalNamesake(genus) {
    if (nonAnimalCache.has(genus)) return nonAnimalCache.get(genus);
    const Cap = genus.charAt(0).toUpperCase() + genus.slice(1);
    const r = await db.get(
      `SELECT COUNT(*) c FROM entities
       WHERE (lower(genus)=? OR scientific_name LIKE ?)
         AND (bio_category IN ('plantae','fungi','microbe') OR kingdom IN ('Plantae','Fungi','Bacteria'))`,
      [genus, Cap + ' %']
    );
    const v = r.c > 0;
    nonAnimalCache.set(genus, v);
    return v;
  }

  const backfill = [], held = [];
  for (const e of rows) {
    const g = genusOf(e.scientific_name);
    if (FUNGAL_GENERA.has(g)) { held.push({ ...e, g, why: 'curated-fungus' }); continue; }
    if (EXCLUDE_GENERA.has(g)) { held.push({ ...e, g, why: 'dual-kingdom-namesake' }); continue; }
    if (await hasNonAnimalNamesake(g)) { held.push({ ...e, g, why: 'db-collision-nonanimal' }); continue; }
    backfill.push({ ...e, g });
  }

  console.log(`Remaining suspects: ${rows.length}. Backfill → Animalia: ${backfill.length}. Held for review: ${held.length}.`);
  console.log(`\n=== BACKFILL kingdom=Animalia (${backfill.length}) ===`);
  for (const e of backfill) console.log(`  ${e.scientific_name} [${e.bio_category}]`);
  console.log(`\n=== HELD (kept NULL-kingdom + flagged) — ${held.length} ===`);
  for (const e of held) console.log(`  ${e.scientific_name} (${e.why})`);

  if (!APPLY) { console.log('\nDRY-RUN — re-run with --apply to write + log revision_log.'); await db.close(); return; }

  await db.run('BEGIN');
  try {
    for (const e of backfill) {
      await db.run(`UPDATE entities SET kingdom='Animalia', needs_taxonomy_review=0, updated_at=datetime('now') WHERE id=?`, [e.id]);
      for (const [f, b, a] of [['kingdom', null, 'Animalia'], ['needs_taxonomy_review', '1', '0']]) {
        await db.run(
          `INSERT INTO revision_log (target_type, target_id, field, before_value, after_value, changed_by, method, reason)
           VALUES ('entity', ?, ?, ?, ?, 'fix-animal-kingdom-backfill.js', 'animal_kingdom_backfill', ?)`,
          [e.id, f, b, a, `genuine animal (bio_category ${e.bio_category}) kingdom backfilled; genus '${e.g}' collision-guarded`]
        );
      }
    }
    await db.run('COMMIT');
    console.log(`\nApplied: ${backfill.length} entities → kingdom=Animalia, ${backfill.length * 2} revision_log rows. Served rows need a host D1 publish.`);
  } catch (err) { await db.run('ROLLBACK'); throw err; }
  await db.close();
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
