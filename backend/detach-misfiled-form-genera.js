#!/usr/bin/env node
'use strict';
/**
 * detach-misfiled-form-genera.js — remove obsolete form-genera from a family
 * they do not belong to, so they cannot inherit a family-rank role.
 *
 * Oospora and Toruloidea are filed under Erysiphaceae (the powdery mildews) in
 * this corpus. They are not powdery mildews: Oospora is an obsolete form-genus
 * for hyphomycetes (O. lactis = Geotrichum, a dairy/soil saprobe), and
 * Oospora pucciniophila is fungicolous — it grows ON rusts. A family-rank
 * pathogen_fungal rule would brand it a plant pathogen, the same error class as
 * Coniothyrium minitans in the 2026-06-27 incident.
 *
 * NOTE ON EVIDENCE: these rows also carry taxon_order=Helotiales, but that is
 * NOT the evidence — 1,077 Erysiphaceae rows carry Helotiales including genuine
 * Erysiphe and Podosphaera, because the corpus mixes classification systems
 * (see lib/order-consistency.js). The evidence is genus identity alone.
 *
 * Their correct family is genuinely uncertain (that is what a form-genus means),
 * so family is set NULL and needs_taxonomy_review is raised rather than guessed.
 *
 *   node detach-misfiled-form-genera.js           # dry-run
 *   node detach-misfiled-form-genera.js --apply
 *   node detach-misfiled-form-genera.js --undo --apply
 */
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { logRevisions } = require('./lib/revision-log.js');

const DB_PATH = process.env.AEDIN_CORPUS_DB || CORPUS_DB;
const METHOD = 'detach_misfiled_form_genera';
const TARGET_FAMILY = 'Erysiphaceae';
const GENERA = ['Oospora', 'Toruloidea'];

const apply = process.argv.includes('--apply');
const undo = process.argv.includes('--undo');
const db = new Database(DB_PATH);

console.log(`=== detach-misfiled-form-genera (${undo ? 'UNDO' : 'DETACH'}, ${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
console.log(`db  ${DB_PATH}\n`);

if (undo) {
  const logged = db.prepare(
    `SELECT target_id, field, before_value FROM revision_log
     WHERE method = ? AND target_type = 'entity' ORDER BY id DESC`).all(METHOD);
  console.log(`revision_log rows tagged ${METHOD}: ${logged.length}`);
  if (apply) {
    const seen = new Set();
    const tx = db.transaction(() => {
      for (const r of logged) {
        const key = `${r.target_id}:${r.field}`;
        if (seen.has(key)) continue;          // newest wins
        seen.add(key);
        db.prepare(`UPDATE entities SET ${r.field} = ? WHERE id = ?`).run(r.before_value, r.target_id);
      }
      db.prepare(`DELETE FROM revision_log WHERE method = ?`).run(METHOD);
    });
    tx();
    console.log(`Restored ${seen.size} field values. Re-run: node apply-role-rules.js --family ${TARGET_FAMILY}`);
  } else console.log('Dry run. Re-run with --apply.');
  process.exit(0);
}

const rows = db.prepare(
  `SELECT id, scientific_name, genus, family, needs_taxonomy_review, primary_role
   FROM entities WHERE family = ? AND genus IN (${GENERA.map(() => '?').join(',')})`
).all(TARGET_FAMILY, ...GENERA);

console.log(`Detaching ${rows.length} entities from ${TARGET_FAMILY}:\n`);
for (const r of rows) {
  console.log(`  ${r.scientific_name.padEnd(28)} family=${r.family} -> NULL   review=${r.needs_taxonomy_review || 0} -> 1   role=${r.primary_role}`);
}

if (!apply) { console.log(`\nDry run. Re-run with --apply.`); process.exit(0); }

const tx = db.transaction(() => {
  for (const r of rows) {
    db.prepare(`UPDATE entities SET family = NULL, needs_taxonomy_review = 1 WHERE id = ?`).run(r.id);
    logRevisions(db, {
      targetType: 'entity', targetId: r.id, changedBy: 'curation', method: METHOD,
      reason: `${r.genus} is an obsolete form-genus, not a powdery mildew; detached from ${TARGET_FAMILY} so it cannot inherit a family-rank pathogen role. Correct placement unknown.`,
      changes: [
        { field: 'family', before: r.family, after: null },
        { field: 'needs_taxonomy_review', before: r.needs_taxonomy_review, after: 1 },
      ],
    });
  }
});
tx();
console.log(`\nDetached ${rows.length} entities, logged to revision_log (method=${METHOD}).`);
