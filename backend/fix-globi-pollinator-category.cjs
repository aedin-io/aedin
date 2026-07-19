#!/usr/bin/env node
/**
 * fix-globi-pollinator-category.cjs — retroactively apply the `hasHost` pollinator
 * guard (lib/globi-classify.js) to already-loaded GloBI claims.
 *
 * ROOT CAUSE: GloBI uses `hasHost` broadly. The generic rule "invertebrate has
 * host plant -> pest_pressure" branded every BEE->plant hasHost record a crop
 * pest, because a bee IS an invertebrate and its "host plant" is its FORAGE
 * plant. That produced the pollinator-as-pest artifact (~410 bee claims, and a
 * wider pollinator tail) which then polluted the emergent-biocontrol discovery
 * layer (a "pest" node that is actually a pollinator, preyed on by a beewolf).
 *
 * METHOD: rather than duplicate the mapping logic, this re-runs the (now fixed)
 * classifyTriple() over the affected candidate set and writes back only where the
 * derived category CHANGES. That makes it self-limiting — a genuine herbivore
 * re-derives to pest_pressure and is left alone — and keeps one source of truth.
 *
 * Dry-run by default; --apply writes + revision_logs every field change.
 */
'use strict';
const D = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { classifyTriple } = require('./lib/globi-classify');
const { logRevisions } = require('./lib/revision-log');

const APPLY = process.argv.includes('--apply');
const RAW_TERM = 'hasHost';
const FROM_CAT = 'pest_pressure';

const db = new D(CORPUS_DB);

// entity lookup (the exact fields the loader feeds the classifier)
const ents = new Map();
for (const e of db.prepare('SELECT id, scientific_name, primary_role, bio_category, family FROM entities').all()) ents.set(e.id, e);

const rows = db.prepare(
  'SELECT id, subject_entity_id, object_entity_id, interaction_category, effect_direction, applied_weight, resolution_path FROM claims WHERE interaction_type_raw = ? AND interaction_category = ?'
).all(RAW_TERM, FROM_CAT);

let changed = 0, unchanged = 0, skipped = 0;
const newCatDist = {};
const run = db.transaction(() => {
  for (const c of rows) {
    const src = ents.get(c.subject_entity_id), tgt = ents.get(c.object_entity_id);
    if (!src || !tgt) { skipped++; continue; }
    let r; try { r = classifyTriple(src, tgt, RAW_TERM); } catch (e) { skipped++; continue; }
    if (!r || !r.category || r.category === c.interaction_category) { unchanged++; continue; }
    changed++; newCatDist[r.category] = (newCatDist[r.category] || 0) + 1;
    if (APPLY) {
      db.prepare('UPDATE claims SET interaction_category = ?, effect_direction = ?, applied_weight = ?, resolution_path = ? WHERE id = ?')
        .run(r.category, r.effect ?? c.effect_direction, r.weight ?? c.applied_weight, r.path ?? c.resolution_path, c.id);
      logRevisions(db, { targetType: 'claim', targetId: c.id,
        changes: [
          { field: 'interaction_category', before: c.interaction_category, after: r.category },
          { field: 'effect_direction', before: c.effect_direction, after: r.effect ?? c.effect_direction },
        ],
        changedBy: 'globi-pollinator-fix', method: 'hasHost-pollinator-guard',
        reason: 'bee/pollinator host-PLANT is forage, not pest association' });
    }
  }
});
run();

console.log(`=== GloBI pollinator-as-pest re-derive ${APPLY ? '(APPLIED)' : '(DRY-RUN)'} ===`);
console.log(`candidates (${RAW_TERM} + ${FROM_CAT}): ${rows.length}`);
console.log(`  changed: ${changed} | unchanged (correctly pest): ${unchanged} | skipped (missing entity): ${skipped}`);
console.log('  new categories:', JSON.stringify(newCatDist));
if (!APPLY) console.log('\n(dry-run — re-run with --apply)');
db.close();
