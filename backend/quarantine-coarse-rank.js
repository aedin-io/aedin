'use strict';

/**
 * quarantine-coarse-rank.js — one-time retroactive sweep for the rank-floor
 * policy (lib/taxon-rank-floor.js). Flips review_status of already-promoted
 * `claims` whose subject or object resolves no finer than CLASS, so they drop
 * out of the `ai_reviewed` serving set (D1 + homepage + entity pages all filter
 * review_status='ai_reviewed').
 *
 * REVERSIBLE: sets review_status='quarantined_coarse' (does NOT delete). A
 * timestamped JSON backup of every affected row's (id, old status, subject,
 * object) is written before applying, so the flip is fully restorable.
 *
 * The go-forward gate lives in promote-staged-claims.js; this script only
 * cleans the rows promoted before the gate existed.
 *
 * Usage:
 *   node quarantine-coarse-rank.js            # dry-run + backup, no writes
 *   node quarantine-coarse-rank.js --apply    # backup + flip review_status
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { coarseRankSqlFragment } = require('./lib/taxon-rank-floor');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const APPLY = process.argv.slice(2).includes('--apply');
const DB_PATH = CORPUS_DB;
const BACKUP_DIR = path.join(__dirname, 'backups');

const db = new Database(DB_PATH);

// Affected = ai_reviewed claims with a coarse (class+) subject OR object endpoint.
const coarseSubj = coarseRankSqlFragment('es.scientific_name');
const coarseObj = coarseRankSqlFragment('eo.scientific_name');
const selectSql = `
  SELECT c.id, c.review_status, es.scientific_name AS subj, eo.scientific_name AS obj
  FROM claims c
  JOIN entities es ON es.id = c.subject_entity_id
  JOIN entities eo ON eo.id = c.object_entity_id
  WHERE c.review_status = 'ai_reviewed'
    AND (${coarseSubj} OR ${coarseObj})`;

const affected = db.prepare(selectSql).all();
console.log(`[quarantine] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  affected ai_reviewed claims: ${affected.length}`);

// Rank-band breakdown for visibility (which coarse ranks are being pulled).
const bands = {};
for (const r of affected) {
  const m = (r.subj + ' ' + r.obj).match(/\((class|subclass|superclass|infraclass|phylum|subphylum|kingdom|division)\)/i);
  const k = m ? m[1].toLowerCase() : 'other';
  bands[k] = (bands[k] || 0) + 1;
}
console.log('[quarantine] by coarsest rank token:', JSON.stringify(bands));

// Always write the backup (cheap, restorable).
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(BACKUP_DIR, `quarantine-coarse-rank-${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify({ created_at: new Date().toISOString(), affected }, null, 2));
console.log(`[quarantine] backup written: ${backupFile} (${(fs.statSync(backupFile).size / 1024).toFixed(1)} KB)`);

if (!APPLY) {
  console.log('[quarantine] DRY-RUN — nothing changed. Re-run with --apply to flip review_status.');
  console.log('[quarantine] sample (first 12):');
  for (const r of affected.slice(0, 12)) console.log(`  #${r.id}  ${r.subj}  ⇄  ${r.obj}`);
  db.close();
  process.exit(0);
}

const ids = affected.map(r => r.id);
const ph = ids.map(() => '?').join(',');
const res = db.prepare(
  `UPDATE claims SET review_status='quarantined_coarse' WHERE id IN (${ph})`
).run(...ids);
console.log(`[quarantine] UPDATED ${res.changes} claims → review_status='quarantined_coarse'`);
console.log(`[quarantine] reversible: restore with UPDATE claims SET review_status='ai_reviewed' WHERE id IN (<backup ids>).`);
db.close();
