#!/usr/bin/env node
'use strict';
/**
 * resweep-stale-roles.js — re-evaluate entities still holding a role written by
 * a rule that is now disabled.
 *
 * Disabling the coarse rules on 2026-06-27 did not rewrite the roles they had
 * already assigned. Those entities carry a role no live rule would reproduce:
 * moths labelled pest_insect for being moths, plants labelled weed for being
 * plants — the exact false-role class the family floor was created to delete.
 *
 * Each stale entity is re-run through the AUDITED path — apply-role-rules.js's
 * exported reclassifyEntity — so it lands on a live rule, on its own claim
 * evidence, or on 'unclassified'. Assignment logic is reused, never
 * reimplemented. Note that some stale rows keep their value and merely gain
 * correct provenance (ants: disabled hymenoptera rule -> enabled Formicidae rule).
 *
 * Reversibility: a timestamped JSON backup of (id, old_role) is written to
 * backend/backups/ before any write; --undo replays it.
 *
 *   node resweep-stale-roles.js                    # dry-run
 *   node resweep-stale-roles.js --apply
 *   node resweep-stale-roles.js --undo=<backup.json> --apply
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB, BACKEND_DIR } = require('./lib/db-paths.cjs');
const { STALE_PROVENANCE_CANDIDATES_SQL } = require('./lib/stale-role.js');
const { preloadRules, computeInteractionProfile } = require('./lib/role-engine.js');
const { reclassifyEntity } = require('./apply-role-rules.js');

const DB_PATH = process.env.AEDIN_CORPUS_DB || CORPUS_DB;
const arg = (f) => {
  const h = process.argv.find(a => a.startsWith(`--${f}=`));
  return h ? h.slice(f.length + 3) : null;
};

async function sweep(db, { apply }) {
  const stale = await db.all(
    `SELECT DISTINCT e.id, e.scientific_name, e.genus, e.family, e.bio_category,
            e.primary_role, e.taxonomy_path, e.kingdom, e.phylum, e.taxon_class, e.taxon_order
     ${STALE_PROVENANCE_CANDIDATES_SQL}`);
  const cache = await preloadRules(db);
  const outcome = {}, transitions = {};
  for (const e of stale) {
    const profile = await computeInteractionProfile(db, e.id);
    const res = await reclassifyEntity(db, e, cache, {
      unmatchedToUnclassified: true, dryRun: !apply, profile,
    });
    outcome[res.status] = (outcome[res.status] || 0) + 1;
    const to = res.assignedRole || e.primary_role;
    if (to !== e.primary_role) {
      const k = `${e.primary_role} -> ${to}`;
      transitions[k] = (transitions[k] || 0) + 1;
    }
  }
  return { candidates: stale, outcome, transitions };
}

if (require.main === module) (async () => {
  const apply = process.argv.includes('--apply');
  const undoFile = arg('undo');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout=30000');

  if (undoFile) {
    const backup = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
    console.log(`=== resweep-stale-roles UNDO (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`restoring ${backup.rows.length} roles from ${undoFile}`);
    if (apply) {
      await db.run('BEGIN TRANSACTION');
      for (const r of backup.rows) {
        await db.run('UPDATE entities SET primary_role = ? WHERE id = ?', [r.old_role, r.id]);
      }
      await db.run('COMMIT');
      console.log('Restored.');
    } else console.log('Dry run. Re-run with --apply.');
    await db.close();
    return;
  }

  // Candidate list first, so the backup captures pre-sweep roles.
  const preview = await sweep(db, { apply: false });
  console.log(`=== resweep-stale-roles (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`db     ${DB_PATH}`);
  console.log(`stale  ${preview.candidates.length} provenance candidates\n`);

  let backupPath = null;
  if (apply) {
    fs.mkdirSync(path.join(BACKEND_DIR, 'backups'), { recursive: true });
    backupPath = path.join(BACKEND_DIR, 'backups',
      `stale-role-resweep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(
      { created: new Date().toISOString(),
        rows: preview.candidates.map(e => ({ id: e.id, old_role: e.primary_role })) }, null, 2));
    console.log(`backup -> ${backupPath}\n`);
  }

  if (apply) await db.run('BEGIN TRANSACTION');
  const { outcome, transitions } = apply ? await sweep(db, { apply: true }) : preview;
  if (apply) await db.run('COMMIT');

  console.log('outcomes:');
  for (const [k, v] of Object.entries(outcome).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log('\nrole transitions:');
  for (const [k, v] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  if (!apply) console.log('\nDry run. Re-run with --apply.');
  else console.log(`\nApplied. Undo: node resweep-stale-roles.js --undo=${backupPath} --apply`);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });

module.exports = { sweep };
