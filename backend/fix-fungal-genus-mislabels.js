#!/usr/bin/env node
'use strict';
/**
 * fix-fungal-genus-mislabels.js — curated-genus correction for the animal-tagged + NULL-kingdom
 * corruption suspects whose GENUS is an unambiguous fungal genus (lib/curated-genera.js
 * FUNGAL_GENERA). These obscure historical fungal binomials don't resolve via GBIF (see
 * classify-animal-tagged-suspects.js — all 107 abstained), so the curated genus NAME is the signal.
 *
 * Flips bio_category invertebrate/vertebrate → 'fungi', sets kingdom='Fungi', clears
 * needs_taxonomy_review; revision_log-logged. Conservative DATA GUARD: skips any genus that ALSO
 * has a confirmed-animal entity (kingdom Animalia/Metazoa) anywhere in the DB — so a dual-kingdom
 * namesake slipping into the curated set can never mis-flip a real animal. Dry-run by default.
 *
 * Usage:
 *   node fix-fungal-genus-mislabels.js            # dry-run
 *   node fix-fungal-genus-mislabels.js --apply     # write + log revision_log
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { FUNGAL_GENERA } = require('./lib/curated-genera');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const APPLY = process.argv.includes('--apply');
const genusOf = (name) => name.replace(/^\[/, '').split(/[\s(]/)[0].toLowerCase();

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const rows = await db.all(
    `SELECT id, scientific_name, bio_category FROM entities
     WHERE bio_category IN ('invertebrate','vertebrate') AND (kingdom IS NULL OR kingdom='')
     ORDER BY scientific_name`
  );

  const animalNamesakeCache = new Map();
  async function hasAnimalNamesake(genus) {
    if (animalNamesakeCache.has(genus)) return animalNamesakeCache.get(genus);
    const Cap = genus.charAt(0).toUpperCase() + genus.slice(1);
    const r = await db.get(
      `SELECT COUNT(*) c FROM entities WHERE (lower(genus)=? OR scientific_name LIKE ?) AND kingdom IN ('Animalia','Metazoa')`,
      [genus, Cap + ' %']
    );
    const v = r.c > 0;
    animalNamesakeCache.set(genus, v);
    return v;
  }

  const toFix = [], skippedCollision = [];
  for (const e of rows) {
    const g = genusOf(e.scientific_name);
    if (!FUNGAL_GENERA.has(g)) continue;
    if (await hasAnimalNamesake(g)) { skippedCollision.push({ ...e, g }); continue; }
    toFix.push({ ...e, g });
  }

  console.log(`Suspects: ${rows.length}. Curated-fungal-genus matches: ${toFix.length + skippedCollision.length}.`);
  console.log(`=== WILL FIX → fungi (${toFix.length}) ===`);
  for (const e of toFix) console.log(`  ${e.scientific_name}  [${e.bio_category} → fungi]`);
  if (skippedCollision.length) {
    console.log(`\n=== SKIPPED (genus has a confirmed-animal namesake in DB) — ${skippedCollision.length} ===`);
    for (const e of skippedCollision) console.log(`  ${e.scientific_name} (genus ${e.g})`);
  }

  if (!APPLY) { console.log('\nDRY-RUN — re-run with --apply to write + log revision_log.'); await db.close(); return; }

  await db.run('BEGIN');
  try {
    let n = 0;
    for (const e of toFix) {
      await db.run(
        `UPDATE entities SET bio_category='fungi', kingdom='Fungi', needs_taxonomy_review=0, updated_at=datetime('now') WHERE id=?`,
        [e.id]
      );
      const changes = [
        ['bio_category', e.bio_category, 'fungi'],
        ['kingdom', null, 'Fungi'],
        ['needs_taxonomy_review', '1', '0'],
      ];
      for (const [f, b, a] of changes) {
        await db.run(
          `INSERT INTO revision_log (target_type, target_id, field, before_value, after_value, changed_by, method, reason)
           VALUES ('entity', ?, ?, ?, ?, 'fix-fungal-genus-mislabels.js', 'curated_genus_reclassify', ?)`,
          [e.id, f, b, a, `animal-tagged fungal genus '${e.g}' corrected to fungi (curated FUNGAL_GENERA, collision-guarded)`]
        );
      }
      n++;
    }
    await db.run('COMMIT');
    console.log(`\nApplied: ${n} entities → fungi, ${n * 3} revision_log rows.`);
    console.log('NOTE: served rows — a D1 publish is needed to reflect these live (run on the host).');
  } catch (err) { await db.run('ROLLBACK'); throw err; }
  await db.close();
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
