#!/usr/bin/env node
'use strict';
/**
 * apply-family-verdicts.js — phase 3 of the gated family-rule curation pass.
 *
 * Inserts role_rules rows for families a domain critic returned as ASSERT.
 * Refuses any verdict carrying exceptions: role_rules cannot express
 * "assert for the family EXCEPT these genera" without a genus rule, and
 * role-engine.js returns at the genus tier before consulting claim evidence,
 * so such a rule would silently suppress evidence-based classification.
 *
 * This script only writes RULES. Assigning roles to entities is the separate,
 * already-audited step:  node apply-role-rules.js --apply
 *
 * Dry-run by default. Reversible: rows carry source='family_curation_2026_08'.
 *
 *   node apply-family-verdicts.js --verdicts=<file>                 # dry-run
 *   node apply-family-verdicts.js --verdicts=<file> --confidence=high
 *   node apply-family-verdicts.js --verdicts=<file> --families=Pucciniaceae,Meliolaceae
 *   node apply-family-verdicts.js --verdicts=<file> --apply
 *   node apply-family-verdicts.js --undo --apply
 *
 * Worktrees have no local corpus DB; set AEDIN_CORPUS_DB.
 */
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { verdictToRules, SOURCE } = require('./lib/family-verdicts.js');

const DB_PATH = process.env.AEDIN_CORPUS_DB || CORPUS_DB;
const arg = (f, d) => {
  const h = process.argv.find(a => a.startsWith(`--${f}=`));
  return h ? h.slice(f.length + 3) : d;
};

(async () => {
  const apply = process.argv.includes('--apply');
  const undo = process.argv.includes('--undo');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  console.log(`=== apply-family-verdicts (${undo ? 'UNDO' : 'ADD'}, ${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`db  ${DB_PATH}\n`);

  if (undo) {
    const rows = await db.all('SELECT id, match_value, assigned_role FROM role_rules WHERE source = ?', [SOURCE]);
    for (const r of rows) console.log(`  DELETE [taxonomy_family] ${r.match_value} -> ${r.assigned_role}`);
    if (apply) {
      await db.run('DELETE FROM role_rules WHERE source = ?', [SOURCE]);
      console.log(`\nDeleted ${rows.length} rules. Re-run: node apply-role-rules.js --apply`);
    } else console.log(`\n${rows.length} rules would be deleted. Re-run with --apply.`);
    await db.close();
    return;
  }

  const verdictsFile = arg('verdicts', null);
  if (!verdictsFile) { console.error('--verdicts=<file> is required'); process.exit(1); }
  const wantConfidence = arg('confidence', null);
  const wantFamilies = arg('families', null);
  const familyFilter = wantFamilies
    ? new Set(wantFamilies.split(',').map(f => f.trim().toLowerCase())) : null;

  const { verdicts } = JSON.parse(fs.readFileSync(verdictsFile, 'utf8'));
  const asserts = verdicts.filter(v => v.verdict === 'assert'
    && (!wantConfidence || v.confidence === wantConfidence)
    && (!familyFilter || familyFilter.has(v.family.toLowerCase())));

  const toInsert = [], held = [];
  for (const v of asserts) {
    try {
      toInsert.push(...verdictToRules(v));
    } catch (err) {
      held.push({ family: v.family, why: err.message });
    }
  }

  console.log(`assert verdicts   ${asserts.length}${wantConfidence ? ` (confidence=${wantConfidence})` : ''}`);
  console.log(`insertable        ${toInsert.length}`);
  console.log(`HELD              ${held.length}\n`);

  for (const r of toInsert) {
    const n = await db.get(
      `SELECT COUNT(*) c FROM entities WHERE lower(family)=? AND merged_into_entity_id IS NULL`, [r.match_value]);
    const u = await db.get(
      `SELECT COUNT(*) c FROM entities WHERE lower(family)=? AND merged_into_entity_id IS NULL AND primary_role='unclassified'`, [r.match_value]);
    console.log(`  + ${r.match_value.padEnd(22)} -> ${r.assigned_role.padEnd(18)} ${String(n.c).padStart(5)} entities (${u.c} currently unclassified)`);
  }
  for (const h of held) console.log(`  ! HELD ${h.family}: ${h.why}`);

  if (!apply) { console.log(`\nDry run. Re-run with --apply to insert.`); await db.close(); return; }

  let inserted = 0;
  for (const r of toInsert) {
    const dup = await db.get(
      `SELECT id FROM role_rules WHERE rule_type=? AND match_field=? AND lower(match_value)=?`,
      [r.rule_type, r.match_field, r.match_value]);
    if (dup) { console.log(`  = skip (already present) ${r.match_value}`); continue; }
    await db.run(
      `INSERT INTO role_rules (rule_type, match_field, match_value, assigned_role, confidence, priority, reason, source, enabled)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.rule_type, r.match_field, r.match_value, r.assigned_role, r.confidence, r.priority, r.reason, r.source, r.enabled]);
    inserted++;
  }
  await db.close();
  console.log(`\nInserted ${inserted} rules. Next: node apply-role-rules.js --apply   (assigns roles + logs role_corrections)`);
})().catch(e => { console.error(e); process.exit(1); });
