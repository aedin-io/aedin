// backend/disable-coarse-role-rules.js
'use strict';
/**
 * Disable coarse (class/order/kingdom + bio_category_default) role_rules so the
 * role engine can no longer assert a role from broad taxonomy. Reversible:
 * rows are flipped enabled=0 (not deleted); --undo re-enables them.
 * Dry-run by default; pass --apply to mutate.
 *
 *   node disable-coarse-role-rules.js            # dry-run audit
 *   node disable-coarse-role-rules.js --apply    # disable coarse rows + retype formicidae
 *   node disable-coarse-role-rules.js --undo --apply   # re-enable (rollback)
 */
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { isCoarseRoleRule } = require('./lib/coarse-rank-audit');

(async () => {
  const apply = process.argv.includes('--apply');
  const undo = process.argv.includes('--undo');
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const rules = await db.all('SELECT id, rule_type, match_value, assigned_role, enabled FROM role_rules');
  const coarse = rules.filter(isCoarseRoleRule);
  const formicidae = rules.find(r => r.rule_type === 'taxonomy_class' && String(r.match_value).toLowerCase() === 'formicidae');

  console.log(`=== disable-coarse-role-rules (${undo ? 'UNDO' : 'DISABLE'}, ${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`Total rules: ${rules.length} | coarse (drop): ${coarse.length} | kept: ${rules.length - coarse.length}`);
  console.log('\nDROP (set enabled=0):');
  for (const r of coarse) console.log(`  [${r.rule_type}] ${r.match_value} -> ${r.assigned_role}`);
  if (formicidae) console.log(`\nKEEP + RETYPE family-rank: formicidae -> ${formicidae.assigned_role} (taxonomy_class -> taxonomy_family)`);

  if (apply) {
    await db.run('BEGIN');
    const targetEnabled = undo ? 1 : 0;
    for (const r of coarse) {
      await db.run("UPDATE role_rules SET enabled=?, updated_at=datetime('now') WHERE id=?", [targetEnabled, r.id]);
    }
    if (!undo && formicidae) {
      await db.run("UPDATE role_rules SET rule_type='taxonomy_family', updated_at=datetime('now') WHERE id=?", [formicidae.id]);
    } else if (undo && formicidae) {
      await db.run("UPDATE role_rules SET rule_type='taxonomy_class', updated_at=datetime('now') WHERE id=?", [formicidae.id]);
    }
    await db.run('COMMIT');
    console.log(`\nApplied: ${coarse.length} rows -> enabled=${targetEnabled}.`);
  } else {
    console.log('\nDry-run: no changes. Re-run with --apply to mutate.');
  }
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
