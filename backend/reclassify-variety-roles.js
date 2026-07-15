#!/usr/bin/env node
'use strict';
/**
 * reclassify-variety-roles.js — follow-on to the family-floor role migration,
 * which scoped to parent entities (parent_entity_id IS NULL) and left VARIETIES
 * with stale roles. A variety (cultivar) shares its parent species' ecological
 * role, so it should inherit the parent's POST-migration primary_role.
 *
 * Guard (information-preserving): inherit parent role for every diverging
 * variety, EXCEPT do not demote an evidenced `crop` variety to an `unclassified`
 * /`neutral` parent (ECOCROP-evidenced cultivar whose parent species didn't match).
 * Tombstones (merged_into_entity_id set) are skipped — they 301-redirect, role unseen.
 *
 * Reversible: every change logged to role_corrections (source='variety_inherit').
 * Dry-run by default; --apply to write.
 *
 *   node reclassify-variety-roles.js            # dry-run
 *   node reclassify-variety-roles.js --apply    # write
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const PRESERVE_VARIETY_ROLE = new Set(['crop']);        // keep these on the variety even if parent is weaker
const WEAK_PARENT = new Set(['unclassified', 'neutral']);

(async () => {
  const apply = process.argv.includes('--apply');
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  await db.run('PRAGMA busy_timeout=30000');

  const rows = await db.all(`
    SELECT e.id, e.scientific_name, e.primary_role AS vrole, e.scope_tier,
           p.primary_role AS prole
    FROM entities e JOIN entities p ON p.id = e.parent_entity_id
    WHERE e.parent_entity_id IS NOT NULL AND e.merged_into_entity_id IS NULL
      AND e.primary_role IS NOT p.primary_role`);

  const toChange = rows.filter(r => !(PRESERVE_VARIETY_ROLE.has(r.vrole) && WEAK_PARENT.has(r.prole)));
  const preserved = rows.length - toChange.length;
  const byTransition = {};
  for (const r of toChange) byTransition[`${r.vrole} → ${r.prole}`] = (byTransition[`${r.vrole} → ${r.prole}`] || 0) + 1;

  console.log(`=== reclassify-variety-roles (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`Diverging varieties: ${rows.length} | to change: ${toChange.length} | preserved (crop vs weak parent): ${preserved}`);
  console.log(`Served among changes: ${toChange.filter(r => r.scope_tier != null).length}`);
  console.log('Transitions:');
  for (const [t, n] of Object.entries(byTransition).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);

  if (apply) {
    await db.run('BEGIN');
    for (const r of toChange) {
      await db.run(`UPDATE entities SET primary_role=?, updated_at=datetime('now') WHERE id=?`, [r.prole, r.id]);
      await db.run(`INSERT INTO role_corrections (entity_id, scientific_name, old_role, new_role, source, reason)
                    VALUES (?,?,?,?, 'variety_inherit', 'variety inherits post-family-floor parent role')`,
                   [r.id, r.scientific_name, r.vrole, r.prole]);
    }
    await db.run('COMMIT');
    console.log(`\nApplied: ${toChange.length} varieties re-roled (logged to role_corrections, reversible).`);
  } else {
    console.log('\nDry-run: no changes. Re-run with --apply.');
  }
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
