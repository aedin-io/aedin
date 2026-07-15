'use strict';
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { logRevisions } = require('./lib/revision-log');
const { normalizeVarietyName, dedupDecision } = require('./lib/variety-promote');

const CHANGED_BY = 'regularize-staging-cultivars';

function isGenusParent(sci) {
  const s = String(sci || '').trim();
  return s === '' || /\bspp\.?$/i.test(s) || !/\s/.test(s); // "Musa spp." or single-word genus
}

// Regularize one extraction_staging cultivar. Idempotent. Returns {action, reason?, needsDedup?}.
function regularizeOne(db, row) {
  const parent = db.prepare('SELECT scientific_name FROM entities WHERE id=?').get(row.parent_entity_id);
  if (!parent || isGenusParent(parent.scientific_name)) return { action: 'hold', reason: 'genus_parent' };

  const name = normalizeVarietyName(row.variety_name);
  const siblings = db.prepare('SELECT id, variety_name FROM entities WHERE parent_entity_id=? AND id!=?')
    .all(row.parent_entity_id, row.id);
  const decision = dedupDecision(siblings, name);
  if (decision.action === 'update') return { action: 'dup', targetId: decision.targetId };

  const needsDedup = decision.action === 'create-flag' ? 1 : 0;
  const changes = [];
  if (row.scope_tier == null) {
    db.prepare('UPDATE entities SET scope_tier=0 WHERE id=?').run(row.id);
    changes.push({ field: 'scope_tier', before: null, after: '0' });
  }
  if (row.needs_dedup !== needsDedup) {
    db.prepare('UPDATE entities SET needs_dedup=? WHERE id=?').run(needsDedup, row.id);
    changes.push({ field: 'needs_dedup', before: String(row.needs_dedup), after: String(needsDedup) });
  }
  if (changes.length) {
    logRevisions(db, { targetType: 'entity', targetId: row.id, changedBy: CHANGED_BY, method: CHANGED_BY, changes });
  }
  return { action: 'served', needsDedup };
}

function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  const rows = db.prepare(
    "SELECT id, scientific_name, variety_name, parent_entity_id, scope_tier, needs_dedup FROM entities WHERE parent_entity_id IS NOT NULL AND source_table='extraction_staging'"
  ).all();
  if (!apply) { db.close(); console.log(`DRY RUN — ${rows.length} staging cultivars. Re-run with --apply.`); return; }
  const tally = { served: 0, hold: 0, dup: 0 };
  const run = db.transaction(() => {
    for (const r of rows) { const res = regularizeOne(db, r); tally[res.action] = (tally[res.action] || 0) + 1; }
  });
  run();
  db.close();
  console.log('Applied:', JSON.stringify(tally));
}

if (require.main === module) main();
module.exports = { regularizeOne, isGenusParent };
