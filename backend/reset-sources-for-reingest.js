'use strict';

/**
 * reset-sources-for-reingest.js — clear the derived rows for a set of sources so
 * they can be re-ingested cleanly through the fixed extractor pipeline
 * (species-resolution glossary; docs/common-name-species-resolution.md).
 *
 * Why: re-ingestion appends fresh staging/claims (dedup is source/queue-level,
 * not per-claim), so without clearing the old rows we'd get duplicates — old
 * (possibly wrong-species) + new (corrected) coexisting. This wipes the old
 * derived rows but PRESERVES the `sources` row (so file_path-keyed re-ingest
 * reuses the same source_id + metadata).
 *
 * SAFETY: always writes a timestamped JSON backup of every row it will delete
 * BEFORE deleting, so the operation is restorable. Dry-run by default.
 *
 * Deletes (for the given source_ids): claim_critic_verdicts (via staging_id),
 * extraction_staging, claims, entity_trait_claims, extraction_queue rows.
 * Keeps: the sources rows.
 *
 * Usage:
 *   node reset-sources-for-reingest.js --source-ids=68,69            # dry-run + backup
 *   node reset-sources-for-reingest.js --source-ids=68,69 --apply    # backup + delete
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const idsArg = argv.find(a => a.startsWith('--source-ids='));
if (!idsArg) { console.error('ERROR: --source-ids=68,69 required'); process.exit(1); }
const sourceIds = idsArg.split('=')[1].split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
if (sourceIds.length === 0) { console.error('ERROR: no valid source ids'); process.exit(1); }

const DB_PATH = CORPUS_DB;
const BACKUP_DIR = path.join(__dirname, 'backups');

const db = new Database(DB_PATH);
const ph = sourceIds.map(() => '?').join(',');

function rows(sql, params = sourceIds) { return db.prepare(sql).all(...params); }

// ── Collect everything we're about to touch (for backup + counts) ────────────
const backup = {
  created_at: new Date().toISOString(),
  source_ids: sourceIds,
  sources: rows(`SELECT * FROM sources WHERE id IN (${ph})`),
  claims: rows(`SELECT * FROM claims WHERE source_id IN (${ph})`),
  entity_trait_claims: rows(`SELECT * FROM entity_trait_claims WHERE source_id IN (${ph})`),
  extraction_staging: rows(`SELECT * FROM extraction_staging WHERE source_id IN (${ph})`),
  claim_critic_verdicts: rows(
    `SELECT v.* FROM claim_critic_verdicts v WHERE v.staging_id IN (SELECT id FROM extraction_staging WHERE source_id IN (${ph}))`
  ),
  extraction_queue: rows(`SELECT * FROM extraction_queue WHERE source_id IN (${ph})`),
};

console.log(`[reset] source_ids=${sourceIds.join(',')}  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log('[reset] rows in scope:');
for (const k of ['sources', 'claims', 'entity_trait_claims', 'extraction_staging', 'claim_critic_verdicts', 'extraction_queue']) {
  console.log(`  ${k}: ${backup[k].length}`);
}

// ── Always write the backup (cheap insurance, restorable) ────────────────────
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(BACKUP_DIR, `reset-sources-${sourceIds.join('_')}-${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
console.log(`[reset] backup written: ${backupFile} (${(fs.statSync(backupFile).size / 1024).toFixed(1)} KB)`);

if (!APPLY) {
  console.log('[reset] DRY-RUN — nothing deleted. Re-run with --apply to delete (keeps sources rows).');
  db.close();
  process.exit(0);
}

// ── Delete (transaction). Verdicts first (FK-ish via staging_id), then the rest.
const del = db.transaction(() => {
  const v = db.prepare(`DELETE FROM claim_critic_verdicts WHERE staging_id IN (SELECT id FROM extraction_staging WHERE source_id IN (${ph}))`).run(...sourceIds);
  const s = db.prepare(`DELETE FROM extraction_staging WHERE source_id IN (${ph})`).run(...sourceIds);
  const c = db.prepare(`DELETE FROM claims WHERE source_id IN (${ph})`).run(...sourceIds);
  const e = db.prepare(`DELETE FROM entity_trait_claims WHERE source_id IN (${ph})`).run(...sourceIds);
  const q = db.prepare(`DELETE FROM extraction_queue WHERE source_id IN (${ph})`).run(...sourceIds);
  return { verdicts: v.changes, staging: s.changes, claims: c.changes, entity_traits: e.changes, queue: q.changes };
});
const res = del();
console.log('[reset] DELETED:', JSON.stringify(res));
console.log('[reset] sources rows preserved (file_path-keyed re-ingest will reuse them).');
db.close();
