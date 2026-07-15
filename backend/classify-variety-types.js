'use strict';
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { logRevisions } = require('./lib/revision-log');
const { classifyVarietyType } = require('./lib/variety-classify');

const CHANGED_BY = 'classify-variety-types';

// Classify one variety row; write + log only if the value changed. Returns the variety_type.
function classifyOne(db, row) {
  const next = classifyVarietyType(row);
  if (row.variety_type === next) return next;
  db.prepare('UPDATE entities SET variety_type=? WHERE id=?').run(next, row.id);
  logRevisions(db, {
    targetType: 'entity', targetId: row.id, changedBy: CHANGED_BY, method: CHANGED_BY,
    changes: [{ field: 'variety_type', before: row.variety_type, after: next }],
  });
  return next;
}

function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  const rows = db.prepare('SELECT id, scientific_name, variety_name, variety_type FROM entities WHERE parent_entity_id IS NOT NULL').all();
  const tally = {};
  if (!apply) {
    for (const r of rows) { const t = classifyVarietyType(r); tally[t] = (tally[t] || 0) + 1; }
    db.close();
    console.log(`DRY RUN — ${rows.length} varieties:`, JSON.stringify(tally), '\nRe-run with --apply.');
    return;
  }
  const run = db.transaction(() => {
    for (const r of rows) { const t = classifyOne(db, r); tally[t] = (tally[t] || 0) + 1; }
  });
  run();
  db.close();
  console.log('Applied:', JSON.stringify(tally));
}

if (require.main === module) main();
module.exports = { classifyOne };
