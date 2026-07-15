'use strict';
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { logRevisions } = require('./lib/revision-log');
const { grinGate } = require('./lib/grin-gate');
const { dedupDecision, normalizeVarietyName } = require('./lib/variety-promote');
const { slugify, uniqueSlug } = require('./lib/slugify');

const CHANGED_BY = 'promote-grin-varieties';

function markPromoted(db, acc) {
  db.prepare("UPDATE grin_varieties SET promoted_at=datetime('now') WHERE grin_accession=?").run(acc);
}

// Promote one staged GRIN row. Idempotent. Returns {action, variety_type?, reason?}.
function promoteOne(db, row) {
  if (row.promoted_at) return { action: 'skip', reason: 'already_promoted' };
  const acc = row.grin_accession;
  const existingAcc = db.prepare('SELECT id FROM entities WHERE grin_accession=?').get(acc);
  if (existingAcc) { markPromoted(db, acc); return { action: 'skip', reason: 'accession_exists' }; }

  const gate = grinGate(row);
  if (!gate.promote) return { action: 'skip', reason: gate.reason };   // stays staged (provenance / future CWR)

  const parent = db.prepare('SELECT scientific_name FROM entities WHERE id=?').get(row.parent_entity_id);
  if (!parent) return { action: 'skip', reason: 'no_parent' };
  const name = normalizeVarietyName(gate.name);
  const siblings = db.prepare('SELECT id, variety_name FROM entities WHERE parent_entity_id=?').all(row.parent_entity_id);
  const decision = dedupDecision(siblings, name);

  if (decision.action === 'update') {
    db.prepare('UPDATE entities SET grin_accession=COALESCE(grin_accession, ?) WHERE id=?').run(acc, decision.targetId);
    logRevisions(db, { targetType: 'entity', targetId: decision.targetId, changedBy: CHANGED_BY, method: CHANGED_BY,
      changes: [{ field: 'grin_accession', before: null, after: acc }] });
    markPromoted(db, acc);
    return { action: 'enrich', targetId: decision.targetId };
  }

  const needsDedup = decision.action === 'create-flag' ? 1 : 0;
  const sci = `${parent.scientific_name} '${name}'`;
  const slug = uniqueSlug(db, slugify(sci));
  const info = db.prepare(
    `INSERT INTO entities (scientific_name, common_name, variety_name, parent_entity_id, bio_category, primary_role,
       source_table, scope_tier, needs_dedup, variety_type, grin_accession, slug)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(sci, name, name, row.parent_entity_id, 'plantae', 'crop', 'grin', 0, needsDedup, gate.variety_type, acc, slug);
  logRevisions(db, { targetType: 'entity', targetId: info.lastInsertRowid, changedBy: CHANGED_BY, method: CHANGED_BY,
    changes: [{ field: 'created', before: null, after: sci }] });
  markPromoted(db, acc);
  return { action: 'create', variety_type: gate.variety_type };
}

function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  const rows = db.prepare('SELECT * FROM grin_varieties WHERE promoted_at IS NULL').all();
  if (!apply) { db.close(); console.log(`DRY RUN — ${rows.length} un-promoted staged GRIN rows. Re-run with --apply.`); return; }
  const tally = {};
  const run = db.transaction(() => {
    for (const r of rows) { const res = promoteOne(db, r); const k = res.action === 'skip' ? `skip:${res.reason}` : res.action; tally[k] = (tally[k] || 0) + 1; }
  });
  run();
  db.close();
  console.log('Applied:', JSON.stringify(tally, null, 0));
}

if (require.main === module) main();
module.exports = { promoteOne };
