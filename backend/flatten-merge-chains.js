'use strict';
/**
 * flatten-merge-chains.js — flatten chained entities.merged_into_entity_id to the
 * terminal (non-tombstone) canonical, and re-point any stray claim/trait/parent FK
 * that still points at a tombstone to that FK's terminal. Reversible (every change
 * logged to revision_log), dry-run default (--apply to commit), idempotent.
 *
 * Root cause it repairs: the merge rail sweeps a loser's claims forward at each
 * merge, but only updates the CURRENT loser's merged_into pointer — so when a
 * canonical is later merged, earlier losers' pointers chain through a tombstone.
 *
 * Usage: node backend/flatten-merge-chains.js [--apply]
 */
const { logRevisions } = require('./lib/revision-log.js');

const FK_TARGETS = [
  ['claims', 'subject_entity_id', 'claim'],
  ['claims', 'object_entity_id', 'claim'],
  ['entity_trait_claims', 'entity_id', 'trait_claim'],
  ['entities', 'parent_entity_id', 'entity'],
];

function buildTerminalResolver(db) {
  const rows = db.prepare('SELECT id, merged_into_entity_id AS mi FROM entities WHERE merged_into_entity_id IS NOT NULL').all();
  const mi = new Map(rows.map(r => [r.id, r.mi]));
  function terminal(id) {
    const seen = new Set();
    let cur = id;
    while (mi.has(cur)) {
      if (seen.has(cur)) throw new Error(`cycle in merge chain at entity ${cur}`);
      seen.add(cur);
      cur = mi.get(cur);
    }
    return cur;
  }
  return { mi, terminal };
}

function planFlatten(db) {
  const { mi, terminal } = buildTerminalResolver(db);
  const tombs = [...mi.keys()];
  const pointerChanges = [];
  for (const [id, cur] of mi) {
    const t = terminal(id);
    if (t !== cur) pointerChanges.push({ id, before: cur, after: t });
  }
  const fkChanges = [];
  if (tombs.length) {
    const inList = tombs.join(',');
    for (const [table, col, tt] of FK_TARGETS) {
      const refs = db.prepare(`SELECT id, ${col} AS ref FROM ${table} WHERE ${col} IN (${inList})`).all();
      for (const r of refs) fkChanges.push({ table, col, tt, id: r.id, before: r.ref, after: terminal(r.ref) });
    }
  }
  return { pointerChanges, fkChanges };
}

function applyPlan(db, plan) {
  const upEnt = db.prepare('UPDATE entities SET merged_into_entity_id=? WHERE id=?');
  for (const c of plan.pointerChanges) {
    upEnt.run(c.after, c.id);
    logRevisions(db, { targetType: 'entity', targetId: c.id, changedBy: 'flatten-merge-chains.js',
      method: 'flatten_merge_chain', changes: [{ field: 'merged_into_entity_id', before: c.before, after: c.after }] });
  }
  for (const c of plan.fkChanges) {
    db.prepare(`UPDATE ${c.table} SET ${c.col}=? WHERE id=?`).run(c.after, c.id);
    logRevisions(db, { targetType: c.tt, targetId: c.id, changedBy: 'flatten-merge-chains.js',
      method: 'flatten_merge_chain_fk', changes: [{ field: c.col, before: c.before, after: c.after }] });
  }
  return { pointers: plan.pointerChanges.length, fks: plan.fkChanges.length };
}

module.exports = { buildTerminalResolver, planFlatten, applyPlan };

if (require.main === module) {
  const Database = require('better-sqlite3');
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const APPLY = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  const plan = planFlatten(db);
  console.log(`[flatten] pointer flattens: ${plan.pointerChanges.length}, stray FK re-points: ${plan.fkChanges.length}`);
  for (const c of plan.pointerChanges.slice(0, 10)) console.log(`  entity ${c.id}: merged_into ${c.before} -> ${c.after}`);
  for (const c of plan.fkChanges.slice(0, 10)) console.log(`  ${c.table}.${c.col} #${c.id}: ${c.before} -> ${c.after}`);
  if (!APPLY) { console.log('DRY RUN — re-run with --apply to commit.'); db.close(); process.exit(0); }
  const tx = db.transaction(() => applyPlan(db, plan));
  const n = tx();
  console.log(`[flatten] applied: ${n.pointers} pointers, ${n.fks} FK re-points.`);
  db.close();
}
