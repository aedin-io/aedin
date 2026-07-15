'use strict';

/**
 * recovery-reset-verdicts.js — Pass-13 recovery run. Deletes the existing
 * (mis-routed / pre-fix) multi-critic verdicts for gate-failed-but-recoverable
 * staging rows so multi-critic-batch-prepare.js re-routes them through the
 * FIXED router (e859033) + FIXED agroecologist scope (8dc7f86) + new toxicity
 * 'present' value (97033a6). Rows that genuinely earned an `implausible` are
 * left alone (correct rejects).
 *
 * Recoverable = Pass-13 source, vouch plausible/uncertain, NOT promoted, has
 * >=1 verdict, <2 plausible, 0 implausible (failed on routing/scope, not merit).
 *
 * Backup of every deleted verdict is written before deleting (reversible).
 *
 * Usage: node recovery-reset-verdicts.js [--apply]
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const APPLY = process.argv.slice(2).includes('--apply');
const db = new Database(CORPUS_DB);
const BACKUP_DIR = path.join(__dirname, 'backups');

// Optional --ids=1,2,3 targets an exact set (e.g. rows a router fix now
// re-routes); otherwise the default gate-failed-recoverable query runs.
const idsFlag = process.argv.find(s => s.startsWith('--ids='));
const recoverable = idsFlag
  ? idsFlag.split('=', 2)[1].split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger)
  : db.prepare(`
  SELECT es.id FROM extraction_staging es
  WHERE es.source_id IN (SELECT id FROM sources WHERE file_path LIKE '%/extension/uog_ceo_%' OR id=6)
    AND es.ai_vouch_status IN ('plausible','uncertain')
    AND (es.review_status IS NULL OR es.review_status != 'promoted')
    AND EXISTS (SELECT 1 FROM claim_critic_verdicts v WHERE v.staging_id=es.id)
    AND (SELECT COUNT(*) FROM claim_critic_verdicts v WHERE v.staging_id=es.id AND v.verdict='plausible') < 2
    AND (SELECT COUNT(*) FROM claim_critic_verdicts v WHERE v.staging_id=es.id AND v.verdict='implausible') = 0
`).all().map(r => r.id);

console.log(`[recovery] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  recoverable staging rows: ${recoverable.length}`);
if (!recoverable.length) { db.close(); process.exit(0); }

const ph = recoverable.map(() => '?').join(',');
const verdicts = db.prepare(`SELECT * FROM claim_critic_verdicts WHERE staging_id IN (${ph})`).all(...recoverable);
console.log(`[recovery] verdicts to delete: ${verdicts.length}`);

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(BACKUP_DIR, `recovery-reset-verdicts-${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify({ created_at: new Date().toISOString(), staging_ids: recoverable, verdicts }, null, 2));
console.log(`[recovery] backup: ${backupFile}`);

if (!APPLY) {
  console.log('[recovery] DRY-RUN — re-run with --apply to delete these verdicts and free the rows for re-prepare.');
  db.close();
  process.exit(0);
}

const res = db.prepare(`DELETE FROM claim_critic_verdicts WHERE staging_id IN (${ph})`).run(...recoverable);
console.log(`[recovery] DELETED ${res.changes} verdicts across ${recoverable.length} rows. Reversible from backup.`);
db.close();
