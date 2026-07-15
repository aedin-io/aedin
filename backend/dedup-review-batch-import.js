// backend/dedup-review-batch-import.js
'use strict';
// Import dedup verdicts and apply the gate: same+high→merge (reversible),
// distinct→reject, uncertain/low→stay pending (human tab). Mirrors
// multi-critic-batch-import.js. revision_log is a raw async INSERT (the lib is
// better-sqlite3; this file is async-driver).
const fs = require('fs');
const path = require('path');
const { mergeCandidate } = require('./merge-entity');

const VALID = new Set(['same', 'distinct', 'uncertain']);

async function importVerdicts(db, { verdictsDir, confThreshold = 0.8 }) {
  const files = fs.existsSync(verdictsDir)
    ? fs.readdirSync(verdictsDir).filter(f => f.startsWith('batch-') && f.endsWith('.json')) : [];
  let imported = 0, merged = 0, rejected = 0, escalated = 0, malformed = 0;

  for (const f of files) {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(verdictsDir, f), 'utf8')); }
    catch { malformed++; continue; }
    if (!Array.isArray(rows)) { malformed++; continue; }

    for (const v of rows) {
      if (v == null || v.candidate_id == null || !v.critic || !VALID.has(v.verdict)) { malformed++; continue; }
      await db.run(
        `INSERT OR REPLACE INTO entity_dedup_verdicts
           (candidate_id, critic_name, verdict, confidence, suggested_canonical_id, reasoning, model)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [v.candidate_id, v.critic, v.verdict, v.confidence ?? null,
         v.suggested_canonical_id ?? null, v.reasoning ?? null, v.model ?? 'claude-code-subagent']);
      imported++;

      const cand = await db.get(`SELECT id, status, suggested_canonical_id FROM entity_dedup_candidates WHERE id=?`, v.candidate_id);
      if (!cand || cand.status !== 'pending') continue; // already resolved

      if (v.verdict === 'same' && (v.confidence ?? 0) >= confThreshold) {
        // apply the critic's canonical override before merging
        if (v.suggested_canonical_id != null && v.suggested_canonical_id !== cand.suggested_canonical_id) {
          await db.run(`UPDATE entity_dedup_candidates SET suggested_canonical_id=? WHERE id=?`, [v.suggested_canonical_id, cand.id]);
        }
        const r = await mergeCandidate(db, cand.id, { reviewer_id: 'dedup-review' });
        await db.run(
          `INSERT INTO revision_log (target_type, target_id, field, before_value, after_value, changed_by, method, reason)
           VALUES ('entity', ?, 'merged_into_entity_id', NULL, ?, 'dedup-review', 'entity_dedup_merge', ?)`,
          [r.merged_id, String(r.canonical_id), `${v.critic}: ${v.reasoning || 'same taxon'}`]);
        merged++;
      } else if (v.verdict === 'distinct') {
        await db.run(`UPDATE entity_dedup_candidates SET status='rejected', reviewed_at=datetime('now'), reviewer_id='dedup-review' WHERE id=?`, [cand.id]);
        rejected++;
      } else {
        escalated++; // uncertain OR same-below-threshold → stays pending for the human tab
      }
    }
  }
  return { imported, merged, rejected, escalated, malformed };
}

module.exports = { importVerdicts };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const verdictsDir = process.env.VERDICTS_DIR || path.join(__dirname, 'dedup-review-verdicts');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await db.run('PRAGMA busy_timeout=30000');
    const r = await importVerdicts(db, { verdictsDir, confThreshold: 0.8 });
    console.log(`[dedup-import] imported=${r.imported} merged=${r.merged} rejected=${r.rejected} escalated=${r.escalated} malformed=${r.malformed}`);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
