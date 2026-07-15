'use strict';

/**
 * Migration 036: claim_critic_verdicts gains critic_confidence (0-1) and
 * evidence_strength (strong|moderate|weak|none). Plus the v_review_priority
 * view that ranks staging rows by human-review value.
 */

async function runMigration(db) {
  const cols = (await db.all(`PRAGMA table_info(claim_critic_verdicts)`)).map(c => c.name);
  if (!cols.includes('critic_confidence')) {
    await db.exec(`ALTER TABLE claim_critic_verdicts ADD COLUMN critic_confidence REAL`);
  }
  if (!cols.includes('evidence_strength')) {
    await db.exec(`ALTER TABLE claim_critic_verdicts ADD COLUMN evidence_strength TEXT`);
  }

  await db.exec(`DROP VIEW IF EXISTS v_review_priority`);
  await db.exec(`
    CREATE VIEW v_review_priority AS
    SELECT
      s.id AS staging_id,
      s.target_table,
      s.source_id,
      CASE
        WHEN MAX(CASE WHEN cv.verdict='plausible'   THEN 1 ELSE 0 END)=1
         AND MAX(CASE WHEN cv.verdict='implausible' THEN 1 ELSE 0 END)=1
        THEN 100
        WHEN MIN(cv.verdict)='uncertain' THEN 80
        WHEN MIN(CASE WHEN cv.verdict='plausible' THEN cv.critic_confidence END) < 0.5
        THEN 60
        WHEN MIN(cv.evidence_strength) IN ('weak','none') THEN 40
        WHEN MIN(CASE WHEN cv.verdict='plausible' THEN cv.critic_confidence END) > 0.85
        THEN 10
        ELSE 30
      END AS priority_score
    FROM extraction_staging s
    LEFT JOIN claim_critic_verdicts cv ON cv.staging_id = s.id
    GROUP BY s.id
  `);
  console.log('[migration-036] critic_confidence + evidence_strength + v_review_priority ready.');
}

module.exports = { runMigration };

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
