#!/usr/bin/env node
'use strict';
/**
 * audit-role-rules.js — read-only report on how many entities each enabled role
 * rule actually REACHES, and on rules whose reach has silently changed.
 *
 * Motivation: a rule that matches nothing still READS as coverage during review
 * — someone scanning role_rules sees the taxon handled — while asserting
 * nothing. AEDIN has hit this "declared but inert" shape three times now, and
 * the reason it survives is structural: an unreachable declaration is never
 * contradicted by anything.
 *
 * Taxonomy moving under a fixed rule string breaks it in BOTH directions, and
 * both are reported:
 *
 *   UNDER-REACH  the rule's taxon was demoted or renamed, so the rule matches
 *                little or nothing while the organisms sit at another rank
 *                (`lymantriidae` reaches 6; subfamily Lymantriinae holds 293).
 *   OVER-REACH   the rule's family ABSORBED other groups, so it silently
 *                acquired members nobody re-approved it for (`curculionidae`
 *                took in Scolytinae, and now asserts pest_insect over
 *                fungus-farming ambrosia beetles and saproxylic secondaries).
 *
 * Over-reach is the more dangerous half: it is live and wrong rather than
 * merely inert. Neither is fixed here — this script only reports. Re-keying or
 * retiring a rule is a curation decision for a domain critic, because widening
 * an approved rule's reach is a change in KIND, not in spelling.
 *
 *   node audit-role-rules.js
 *   node audit-role-rules.js --absorbed=curculionidae:Scolytinae,Platypodinae
 */
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { classifyReach, demotedForms, RANKS_FINEST_FIRST } = require('./lib/rule-reach.js');

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };

// Families known to have absorbed a formerly-separate group. A rule on the
// family silently covers the absorbed members too; whether that reach was ever
// approved is exactly what this surfaces.
const ABSORBED = { curculionidae: ['Scolytinae', 'Platypodinae'], erebidae: ['Lymantriinae', 'Arctiinae'] };
for (const pair of (flag('absorbed', '') || '').split(',').filter(Boolean)) {
  const [fam, subs] = pair.split(':');
  if (fam && subs) ABSORBED[fam.toLowerCase()] = subs.split('|');
}

const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB, { readonly: true });
const cols = new Set(db.prepare('PRAGMA table_info(entities)').all().map(c => c.name));
const RANKS = RANKS_FINEST_FIRST.filter(r => cols.has(r));

const rules = db.prepare(
  `SELECT id, rule_type, match_field, match_value, assigned_role, reason
   FROM role_rules WHERE enabled = 1 AND match_field IN ('family','genus','subfamily')
   ORDER BY match_field, match_value`).all();

const countAt = {};
for (const r of RANKS) {
  countAt[r] = db.prepare(
    `SELECT COUNT(*) n FROM entities WHERE LOWER(${r}) = ? AND merged_into_entity_id IS NULL`);
}
const absorbedCount = db.prepare(
  `SELECT COUNT(*) n FROM entities WHERE LOWER(family) = ? AND subfamily = ?
     AND merged_into_entity_id IS NULL`);
const absorbedRoled = db.prepare(
  `SELECT COUNT(*) n FROM entities WHERE LOWER(family) = ? AND subfamily = ?
     AND primary_role = ? AND slug IS NOT NULL AND merged_into_entity_id IS NULL`);

const buckets = { dead: [], rank_mismatch: [], vintage_mismatch: [], underreaching: [], live: [] };
const overreach = [];

for (const rule of rules) {
  const mv = String(rule.match_value).toLowerCase();
  const altRanks = {};
  for (const r of RANKS) altRanks[r] = countAt[r].get(mv).n;
  // A demotion renames the taxon, so also look up the -inae form.
  const demotedAt = {};
  if (cols.has('subfamily')) {
    for (const form of demotedForms(mv)) {
      demotedAt.subfamily = (demotedAt.subfamily || 0) + countAt.subfamily.get(form).n;
    }
  }
  const matched = altRanks[rule.match_field] || 0;
  const res = classifyReach({ matched, ruleRank: rule.match_field, altRanks, demotedAt });
  buckets[res.status].push({ ...rule, ...res });

  const absorbs = ABSORBED[mv];
  if (rule.match_field === 'family' && absorbs) {
    for (const sub of absorbs) {
      const n = absorbedCount.get(mv, sub).n;
      if (!n) continue;
      overreach.push({ rule, sub, n, served: absorbedRoled.get(mv, sub, rule.assigned_role).n });
    }
  }
}

console.log(`=== role-rule reach audit — ${rules.length} enabled taxon rules ===\n`);
for (const [k, label] of [
  ['dead', 'DEAD — match nothing, and the value appears at no other rank'],
  ['rank_mismatch', 'RANK MISMATCH — value is a real taxon at a DIFFERENT rank'],
  ['vintage_mismatch', 'VINTAGE MISMATCH — value demoted; organisms sit at a finer rank'],
  ['underreaching', 'UNDER-REACHING — matches a few, but far more sit at a finer rank'],
]) {
  const b = buckets[k];
  console.log(`${label}: ${b.length}`);
  for (const r of b) {
    console.log(`   ${r.match_value.padEnd(20)} ${String(r.assigned_role).padEnd(18)} matches ${String(r.matched).padStart(5)}` +
      (r.foundAt ? `  — ${r.reachable} sit at ${r.foundAt}` : ''));
  }
  console.log('');
}
console.log(`LIVE (reaching entities as written): ${buckets.live.length}\n`);

console.log('OVER-REACH — the family ABSORBED a group, so the rule covers members nobody re-approved:');
if (!overreach.length) console.log('   none detected');
for (const o of overreach) {
  console.log(`   ${o.rule.match_value} -> ${o.rule.assigned_role}: covers ${o.n} ${o.sub}` +
    `  (${o.served} SERVED entities already carry that role from it)`);
}
console.log('\nThis script reports only. Re-keying or retiring a rule is a curation');
console.log('decision — widening an approved rule is a change in kind, not spelling.');
db.close();
