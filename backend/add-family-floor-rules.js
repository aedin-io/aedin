#!/usr/bin/env node
'use strict';
/**
 * add-family-floor-rules.js — add curated family-rank role rules for
 * functionally-monomorphic, high-value families that the family-floor
 * migration would otherwise leave as `unclassified` (agroecologist caveat,
 * 2026-06-27). These restore genuine mutualist/soil signal via the EXISTING
 * role vocabulary (no new role values):
 *
 *   Glomeraceae   (arbuscular-mycorrhizal fungi)  -> soil_microbe  (matches the 87 already so-classed)
 *   Rhizobiaceae  (N-fixing root-nodule bacteria) -> soil_microbe
 *   Lumbricidae   (earthworms)                    -> neutral       (no soil-fauna role exists; this only de-pests them.
 *                                                                   A dedicated soil-fauna/detritivore role is a vocab follow-on.)
 *
 * Reversible: rows carry source='agroecologist_caveat_family_floor'; `--undo --apply` deletes exactly those.
 * Dry-run by default; `--apply` writes. Idempotent (skips a rule already present by match_value+rule_type).
 *
 *   node add-family-floor-rules.js            # dry-run
 *   node add-family-floor-rules.js --apply    # insert the 3 rules
 *   node add-family-floor-rules.js --undo --apply   # remove them (rollback)
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const SOURCE = 'agroecologist_caveat_family_floor';
const RULES = [
  { match_value: 'glomeraceae',  assigned_role: 'soil_microbe', reason: 'Arbuscular-mycorrhizal fungi: obligate plant mutualists, never pathogens.' },
  { match_value: 'rhizobiaceae', assigned_role: 'soil_microbe', reason: 'N-fixing root-nodule bacteria: plant mutualists, not pathogens.' },
  { match_value: 'lumbricidae',  assigned_role: 'neutral',      reason: 'Earthworms: beneficial soil fauna, not pests (no soil-fauna role in vocab; neutral de-pests).' },
];

(async () => {
  const apply = process.argv.includes('--apply');
  const undo = process.argv.includes('--undo');
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  console.log(`=== add-family-floor-rules (${undo ? 'UNDO' : 'ADD'}, ${apply ? 'APPLY' : 'DRY-RUN'}) ===`);

  if (undo) {
    const existing = await db.all('SELECT id, match_value, assigned_role FROM role_rules WHERE source = ?', [SOURCE]);
    console.log(`Rows tagged ${SOURCE}: ${existing.length}`);
    for (const r of existing) console.log(`  DELETE [taxonomy_family] ${r.match_value} -> ${r.assigned_role}`);
    if (apply) { await db.run('DELETE FROM role_rules WHERE source = ?', [SOURCE]); console.log(`Deleted ${existing.length} rows.`); }
  } else {
    let inserted = 0, skipped = 0;
    for (const r of RULES) {
      const present = await db.get(
        "SELECT id FROM role_rules WHERE rule_type='taxonomy_family' AND LOWER(match_value)=? AND enabled=1",
        [r.match_value]
      );
      if (present) { console.log(`  SKIP (already present): ${r.match_value} -> ${r.assigned_role}`); skipped++; continue; }
      console.log(`  ADD [taxonomy_family] ${r.match_value} -> ${r.assigned_role}  (${r.reason})`);
      if (apply) {
        await db.run(
          `INSERT INTO role_rules (rule_type, match_field, match_value, assigned_role, confidence, priority, reason, source, enabled, created_at, updated_at)
           VALUES ('taxonomy_family', 'family', ?, ?, 0.9, 50, ?, ?, 1, datetime('now'), datetime('now'))`,
          [r.match_value, r.assigned_role, r.reason, SOURCE]
        );
        inserted++;
      }
    }
    console.log(apply ? `\nInserted: ${inserted}, skipped: ${skipped}.` : '\nDry-run: no changes. Re-run with --apply.');
  }
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
