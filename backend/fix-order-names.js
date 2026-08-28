#!/usr/bin/env node
'use strict';
/**
 * fix-order-names.js — align entities.taxon_order with the Open Tree Taxonomy.
 *
 * The corpus mixes taxonomic systems, so one family routinely carries two order
 * names. This adopts OTT's placement for every disagreement (owner decision,
 * 2026-08-25) while recording the two classes SEPARATELY, because they are not
 * the same problem:
 *
 *   fix_order_name_archaic   — our value was not an order in OTT at all
 *                              (superseded names, or a real taxon at the wrong
 *                              rank such as the superorder Psocodea).
 *                              Unambiguous.
 *   fix_order_name_contested — both names are real OTT orders. Adopting OTT is
 *                              picking a side in a live disagreement
 *                              (Mycosphaerellales vs Capnodiales, Pinales vs
 *                              Cupressales). Tagged distinctly so this subset
 *                              can be reviewed or reverted on its own.
 *
 * Families OTT cannot place are left completely alone.
 *
 * WRITES ONE COLUMN: entities.taxon_order. Nothing else.
 *
 *   node fix-order-names.js                     # dry-run
 *   node fix-order-names.js --apply
 *   node fix-order-names.js --undo --apply      # both classes
 *   node fix-order-names.js --undo=contested --apply
 */
const Database = require('better-sqlite3');
const { CORPUS_DB, OTT_DB } = require('./lib/db-paths.cjs');
const { canonicalOrderForFamily, classifyDisagreement } = require('./lib/order-canonical.js');
const { logRevisions } = require('./lib/revision-log.js');

const METHOD = { archaic: 'fix_order_name_archaic', contested: 'fix_order_name_contested' };
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const undoArg = argv.find(a => a === '--undo' || a.startsWith('--undo='));

const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB, apply ? {} : { readonly: true });

if (undoArg) {
  const which = undoArg.includes('=') ? undoArg.split('=')[1] : 'both';
  const methods = which === 'both' ? Object.values(METHOD) : [METHOD[which]];
  const rows = db.prepare(
    `SELECT target_id, before_value FROM revision_log
     WHERE target_type='entity' AND field='taxon_order' AND method IN (${methods.map(() => '?').join(',')})
     ORDER BY id DESC`).all(...methods);
  console.log(`=== fix-order-names UNDO (${which}, ${apply ? 'APPLY' : 'DRY-RUN'}) — ${rows.length} rows ===`);
  if (apply) {
    const seen = new Set();
    db.transaction(() => {
      for (const r of rows) {
        if (seen.has(r.target_id)) continue;      // newest wins
        seen.add(r.target_id);
        db.prepare('UPDATE entities SET taxon_order = ? WHERE id = ?').run(r.before_value, r.target_id);
      }
      db.prepare(`DELETE FROM revision_log WHERE target_type='entity' AND field='taxon_order'
                  AND method IN (${methods.map(() => '?').join(',')})`).run(...methods);
    })();
    console.log(`Restored ${seen.size} rows.`);
  } else console.log('Dry run. Re-run with --apply.');
  process.exit(0);
}

const ottDb = new Database(OTT_DB, { readonly: true });
const entities = db.prepare(
  `SELECT id, scientific_name, family, taxon_order FROM entities
   WHERE family IS NOT NULL AND family <> ''
     AND taxon_order IS NOT NULL AND taxon_order <> ''
     AND merged_into_entity_id IS NULL`).all();

// Family -> canonical order, computed once per family rather than per row.
const canonCache = new Map();
const canonFor = (f) => {
  if (!canonCache.has(f)) canonCache.set(f, canonicalOrderForFamily(ottDb, f));
  return canonCache.get(f);
};

const upd = db.prepare('UPDATE entities SET taxon_order = ? WHERE id = ?');
const tally = { agree: 0, archaic: 0, contested: 0, unplaceable: 0 };
const pairs = { archaic: {}, contested: {} };

const run = db.transaction(() => {
  for (const e of entities) {
    const canon = canonFor(e.family);
    if (!canon) { tally.unplaceable++; continue; }
    const verdict = classifyDisagreement(ottDb, e.taxon_order, canon);
    if (verdict === 'agree') { tally.agree++; continue; }
    tally[verdict]++;
    const key = `${e.taxon_order} -> ${canon}`;
    pairs[verdict][key] = (pairs[verdict][key] || 0) + 1;
    if (!apply) continue;
    upd.run(canon, e.id);
    logRevisions(db, {
      targetType: 'entity', targetId: e.id, changedBy: 'ott-order-align', method: METHOD[verdict],
      reason: verdict === 'archaic'
        ? `"${e.taxon_order}" is not an order in OTT ${'' }— superseded name or wrong rank; family ${e.family} sits in ${canon}`
        : `both "${e.taxon_order}" and "${canon}" are real OTT orders; adopting OTT's placement of family ${e.family}`,
      changes: [{ field: 'taxon_order', before: e.taxon_order, after: canon }],
    });
  }
});
if (apply) run(); else run();

console.log(`=== fix-order-names (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
console.log(`entities considered : ${entities.length}`);
console.log(`  agree             : ${tally.agree}`);
console.log(`  archaic  (fixed)  : ${tally.archaic}`);
console.log(`  contested (fixed) : ${tally.contested}`);
console.log(`  family unplaceable: ${tally.unplaceable}  (left alone)`);
for (const k of ['archaic', 'contested']) {
  const top = Object.entries(pairs[k]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!top.length) continue;
  console.log(`\ntop ${k}:`);
  for (const [p, n] of top) console.log(`  ${String(n).padStart(6)}  ${p}`);
}
if (!apply) console.log('\nDry run. Re-run with --apply.');
db.close(); ottDb.close();
