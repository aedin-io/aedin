'use strict';
/**
 * dedup-entity-trait-claims.js — collapse chunk-overlap duplicate trait claims.
 *
 * Running a monograph both unchunked and chunked re-extracts the same per-species
 * value, so entity_trait_claims accumulates duplicate rows. This pass removes ONLY
 * the safe duplicates and never resolves disagreements:
 *
 *   - EXACT dup  (same entity+trait+value+SAME source) → collapse to one row.
 *     Keep-rule: prefer a row WITH a source_quote (serving needs it; longest wins),
 *     tie-break lowest id (first-extracted).
 *   - cross-VALUE conflict (same entity+trait, differing values) → FLAG for review,
 *     delete nothing. (e.g. Ananas ph_max [6.0, 8.0]; celery edible_part granularity.)
 *   - multi-SOURCE same value (same entity+trait+value, different sources) → KEEP;
 *     independent corroboration is provenance, not duplication.
 *
 * Dry-run by default; pass --apply to mutate. Deleted rows are backed up to
 * backend/backups/ before deletion (reversible). Conflicts are written to a report.
 *
 * Usage:
 *   node dedup-entity-trait-claims.js            # dry-run summary
 *   node dedup-entity-trait-claims.js --apply    # collapse exact dups + write reports
 */

function valueKey(r) {
  return [
    r.value_numeric === null || r.value_numeric === undefined ? '' : r.value_numeric,
    r.value_text === null || r.value_text === undefined ? '' : r.value_text,
    r.value_json === null || r.value_json === undefined ? '' : r.value_json,
  ].join('');
}

function quoteLen(r) {
  return r.source_quote ? String(r.source_quote).length : 0;
}

/**
 * Pure planner. Given entity_trait_claims rows, returns:
 *   { deletions: number[]  (claim ids safe to delete),
 *     conflicts: [{entity_id, trait_name, values: string[], ids: number[]}] }
 */
function planDedup(rows) {
  const byEntityTrait = new Map();
  for (const r of rows) {
    const k = r.entity_id + '' + r.trait_name;
    if (!byEntityTrait.has(k)) byEntityTrait.set(k, []);
    byEntityTrait.get(k).push(r);
  }

  const deletions = [];
  const conflicts = [];

  for (const group of byEntityTrait.values()) {
    // Flag cross-value disagreement within this entity+trait.
    const distinctValues = new Set(group.map(valueKey));
    if (distinctValues.size > 1) {
      conflicts.push({
        entity_id: group[0].entity_id,
        trait_name: group[0].trait_name,
        values: [...distinctValues],
        ids: group.map((r) => r.id),
      });
    }

    // Collapse exact dups: rows sharing (value, source_id).
    const bySrcVal = new Map();
    for (const r of group) {
      const kk = valueKey(r) + '' + r.source_id;
      if (!bySrcVal.has(kk)) bySrcVal.set(kk, []);
      bySrcVal.get(kk).push(r);
    }
    for (const dupRows of bySrcVal.values()) {
      if (dupRows.length < 2) continue;
      // Keep-rule: longest source_quote first, then lowest id.
      dupRows.sort((a, b) => quoteLen(b) - quoteLen(a) || a.id - b.id);
      for (const r of dupRows.slice(1)) deletions.push(r.id);
    }
  }

  deletions.sort((a, b) => a - b);
  return { deletions, conflicts };
}

module.exports = { planDedup, valueKey };

if (require.main === module) {
  (async () => {
    const Database = require('better-sqlite3');
    const fs = require('fs');
    const path = require('path');
    const { CORPUS_DB } = require('./lib/db-paths.cjs');
    const APPLY = process.argv.includes('--apply');
    const db = new Database(CORPUS_DB);

    const rows = db.prepare(
      `SELECT id, entity_id, trait_name, value_numeric, value_text, value_json, source_id, source_quote
         FROM entity_trait_claims`
    ).all();
    const { deletions, conflicts } = planDedup(rows);

    console.log(`[dedup] scanned ${rows.length} trait claims`);
    console.log(`[dedup] exact-dup rows to delete: ${deletions.length}`);
    console.log(`[dedup] cross-value conflicts to flag (NOT deleted): ${conflicts.length}`);

    const stamp = (db.prepare(`SELECT strftime('%Y%m%dT%H%M%S','now') s`).get()).s;
    const backupsDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir);

    // Always write the conflict report (review artifact) even on dry-run.
    const conflictPath = path.join(backupsDir, `trait-dedup-conflicts-${stamp}.json`);
    fs.writeFileSync(conflictPath, JSON.stringify(conflicts, null, 2));
    console.log(`[dedup] conflict report → ${conflictPath}`);

    if (!APPLY) {
      console.log('[dedup] DRY-RUN — pass --apply to delete the exact dups.');
      db.close();
      return;
    }

    // Back up the rows we are about to delete, then delete in one transaction.
    const toDelete = db.prepare(
      `SELECT * FROM entity_trait_claims WHERE id IN (${deletions.map(() => '?').join(',')})`
    );
    const deletedRows = deletions.length ? toDelete.all(...deletions) : [];
    const backupPath = path.join(backupsDir, `trait-dedup-deleted-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(deletedRows, null, 2));

    const del = db.prepare(`DELETE FROM entity_trait_claims WHERE id = ?`);
    const tx = db.transaction((ids) => { for (const id of ids) del.run(id); });
    tx(deletions);
    console.log(`[dedup] APPLIED — deleted ${deletions.length} rows (backup → ${backupPath})`);
    db.close();
  })();
}
