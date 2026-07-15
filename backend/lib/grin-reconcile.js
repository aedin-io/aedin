'use strict';
// grin-reconcile.js — core logic for reconciling the pre-#4 gate-less GRIN entities
// (source_table='grin' AND variety_type IS NULL): identify → FK-safe-guard → delete →
// clear grin_synced_at on the crop-tagged parents so they re-scrape. better-sqlite3 (sync).
// The CLI wrapper (reconcile-grin-gateless.js) adds backup-to-JSON + dry-run/--apply.
const { logRevisions } = require('./revision-log');

// Qualified form required for JOIN queries — both tables expose source_table/variety_type,
// so the unqualified form would be ambiguous (column-ambiguity bug).
const GATELESS_FILTER_Q = "e.source_table='grin' AND e.variety_type IS NULL";

// Full rows (+ parent role/name) for backup + processing, ordered by id.
function selectGateless(db) {
  return db.prepare(`
    SELECT e.id, e.scientific_name, e.variety_name, e.grin_accession, e.parent_entity_id,
           e.native_regions, p.primary_role AS parent_role, p.scientific_name AS parent_name
    FROM entities e LEFT JOIN entities p ON p.id = e.parent_entity_id
    WHERE ${GATELESS_FILTER_Q}
    ORDER BY e.id`).all();
}

// Distinct crop-tagged parent ids of the gate-less set (the okra parents to re-sync).
function cropParentIds(db) {
  return db.prepare(`
    SELECT DISTINCT e.parent_entity_id AS pid
    FROM entities e JOIN entities p ON p.id = e.parent_entity_id
    WHERE ${GATELESS_FILTER_Q} AND p.primary_role = 'crop' AND e.parent_entity_id IS NOT NULL`)
    .all().map(r => r.pid);
}

// Every table.column with a declared FK to entities that references any of `ids`.
// Uses the live schema (PRAGMA foreign_key_list) so it auto-adapts; [] if none.
function findReferences(db, ids) {
  if (!ids.length) return [];
  const idList = ids.map(Number).join(',');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  // Conservative: abort on ANY referencing row, including a target row that
  // references another target (entities self-FK). We do NOT special-case
  // intra-batch self-references — allowing them would require children-first
  // delete ordering to avoid FK errors under foreign_keys=ON. Refusing is safe.
  const hits = [];
  for (const t of tables) {
    let fks;
    try { fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all(); } catch { continue; }
    for (const fk of fks) {
      if (fk.table !== 'entities') continue;
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${fk.from} IN (${idList})`).get().n;
      if (n) hits.push({ table: t, column: fk.from, count: n });
    }
  }
  return hits;
}

// Dry-run view — no mutation.
function summary(db) {
  const rows = selectGateless(db);
  const crop = rows.filter(r => r.parent_role === 'crop').length;
  return {
    total: rows.length,
    crop,
    nonCrop: rows.length - crop,
    cropParents: cropParentIds(db),
    references: findReferences(db, rows.map(r => r.id)),
  };
}

// Apply core. Guard → delete (revision_log each) → clear crop-parent grin_synced_at.
// Throws (err.references set) if any target id is referenced. Caller wraps in a transaction.
function reconcile(db, { changedBy }) {
  const rows = selectGateless(db);
  const ids = rows.map(r => r.id);
  if (!ids.length) return { deleted: 0, cropParentsCleared: 0, rows: [] };

  const refs = findReferences(db, ids);
  if (refs.length) {
    const err = new Error('reconcile aborted — gate-less rows are referenced: ' + JSON.stringify(refs));
    err.references = refs;
    throw err;
  }

  const cropParents = cropParentIds(db);
  const del = db.prepare('DELETE FROM entities WHERE id = ?');
  for (const r of rows) {
    del.run(r.id);
    logRevisions(db, {
      targetType: 'entity', targetId: r.id, changedBy, method: changedBy,
      changes: [{ field: 'deleted', before: `${r.scientific_name} [${r.grin_accession}]`, after: null }],
    });
  }
  const clr = db.prepare('UPDATE entities SET grin_synced_at = NULL WHERE id = ?');
  for (const pid of cropParents) clr.run(pid);

  return { deleted: rows.length, cropParentsCleared: cropParents.length, rows };
}

module.exports = { selectGateless, cropParentIds, findReferences, summary, reconcile };
