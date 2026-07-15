#!/usr/bin/env node
'use strict';
/**
 * apply-disambiguated-25.js — applies the agroecologist-VERIFIED kingdom disambiguation for the
 * 25 dual-kingdom-namesake suspects (the held tail of the 2026-06-16 taxonomy-corruption cleanup).
 * Classifications were proposed from species-epithet + claim context, then reviewed by the
 * agroecologist critic (it corrected 3: held Satyrium austrinus + Diplolepis japonica, promoted
 * Fasta fastuosa → animal). Per-entity + name-checked + revision_log-logged. Dry-run by default.
 *
 * 5 deliberately NOT here (left flagged needs_taxonomy_review for manual/dedup work):
 *   Graphium gracile, Graphium squarrosum (genus dual-kingdom, pest_pressure fits either),
 *   Diplolepis japonica (synonymy hazard), Satyrium austrinus (butterfly|orchid, fuzzy GBIF only),
 *   Plagiochomuus spiniferris (malformed/typo name — dedup-class, not disambiguation).
 *
 * Usage: node apply-disambiguated-25.js [--apply]
 */
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const APPLY = process.argv.includes('--apply');

// id → { name (assert), bio (null=leave bio_category as-is), kingdom }
const FUNGI = [
  [6547, 'Asterina aliena'], [6554, 'Asterina clavuligera'], [6555, 'Asterina coffeicola'],
  [6571, 'Asterina pearsoni'], [6575, 'Asterina pseudopelliculosa'], [6580, 'Asterina subreticulata'],
  [6973, 'Caryospora coffeae'], [8918, 'Fenestella amorpha'], [8936, 'Flammula paxiana'],
  [13105, 'Sphaerella panicum'],
];
const ANIMALS = [
  [1470, 'Aristotelia physaliella'], [15438, 'Diplolepis ashmeadi'], [15441, 'Diplolepis inconspicuis'],
  [15443, 'Diplolepis lens'], [2813, 'Graphium teredon'], [225, 'Harmonia testudinaria'],
  [3593, 'Pachyglossa agilis'], [22693, 'Langsdorfia lunifera'], [24989, 'Stelis (Stelis)'],
  [15690, 'Fasta fastuosa'],
];

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const plan = [];
  for (const [id, name] of FUNGI) plan.push({ id, name, bio: 'fungi', kingdom: 'Fungi' });
  for (const [id, name] of ANIMALS) plan.push({ id, name, bio: null, kingdom: 'Animalia' });

  // name-check guard
  for (const p of plan) {
    const e = await db.get('SELECT scientific_name, bio_category FROM entities WHERE id=?', p.id);
    if (!e) { console.error(`ABORT: entity ${p.id} not found`); process.exit(1); }
    if (e.scientific_name !== p.name) { console.error(`ABORT: id ${p.id} is "${e.scientific_name}", expected "${p.name}"`); process.exit(1); }
    p.curBio = e.bio_category;
  }
  console.log(`Verified ${plan.length} entities (10 → fungi, 10 → kingdom=Animalia). Name-check passed.`);
  for (const p of plan) console.log(`  ${p.name}: ${p.bio ? `bio ${p.curBio}→fungi, ` : ''}kingdom→${p.kingdom}`);

  if (!APPLY) { console.log('\nDRY-RUN — re-run with --apply.'); await db.close(); return; }

  await db.run('BEGIN');
  try {
    let n = 0;
    for (const p of plan) {
      const changes = [];
      if (p.bio) {
        await db.run(`UPDATE entities SET bio_category=?, kingdom=?, needs_taxonomy_review=0, updated_at=datetime('now') WHERE id=?`, [p.bio, p.kingdom, p.id]);
        changes.push(['bio_category', p.curBio, p.bio], ['kingdom', null, p.kingdom], ['needs_taxonomy_review', '1', '0']);
      } else {
        await db.run(`UPDATE entities SET kingdom=?, needs_taxonomy_review=0, updated_at=datetime('now') WHERE id=?`, [p.kingdom, p.id]);
        changes.push(['kingdom', null, p.kingdom], ['needs_taxonomy_review', '1', '0']);
      }
      for (const [f, b, a] of changes) {
        await db.run(
          `INSERT INTO revision_log (target_type, target_id, field, before_value, after_value, changed_by, method, reason)
           VALUES ('entity', ?, ?, ?, ?, 'apply-disambiguated-25.js', 'agroecologist_verified_disambiguation', ?)`,
          [p.id, f, b, a, `dual-kingdom namesake disambiguated (epithet/context + agroecologist review)`]
        );
        n++;
      }
    }
    await db.run('COMMIT');
    console.log(`\nApplied: 10 → fungi, 10 → Animalia. ${n} revision_log rows. Served rows need a host D1 publish.`);
  } catch (err) { await db.run('ROLLBACK'); throw err; }
  await db.close();
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
