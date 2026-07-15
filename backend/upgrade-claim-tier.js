#!/usr/bin/env node
/**
 * upgrade-claim-tier.js — Phase 2.5
 *
 * Bumps `claims.review_status` from 'ai_vouched' (single-Haiku-vouch) to
 * 'ai_reviewed' for rows where the multi-critic pipeline has now
 * recorded consensus (≥2 plausible / 0 implausible) in `claim_critic_verdicts`.
 *
 * Why this script exists:
 *   `promote-staged-claims.js --allow-single-vouch` (used in the early
 *   pre-Phase-2.5 dev path) lifted Haiku-vouched staging rows directly into
 *   `claims` with `review_status='ai_vouched'`. Those rows are NOT served —
 *   the serving-layer gate requires `ai_reviewed` or higher. Once
 *   `vouch-multi-critic.js --include-promoted` records consensus verdicts for
 *   those staging rows, this script promotes the existing `claims` rows to
 *   the served tier without re-inserting them.
 *
 *   Re-running promote-staged-claims would re-INSERT (because each invocation
 *   creates new claim rows from staging). This script runs UPDATE-in-place
 *   on the existing claim rows, which is the right semantics for a tier
 *   upgrade.
 *
 * Mapping claims → staging:
 *   `claims.resolution_path` is set by promote-staged-claims to a string of
 *   the form "Promoted from staging row N (...)". We extract N with a regex.
 *   Rows where the regex fails (legacy / GloBI-derived rows) are skipped.
 *
 * Eligibility for upgrade:
 *   claims.review_status = 'ai_vouched'
 *   AND staging row N has ≥2 plausible verdicts and 0 implausible verdicts
 *       in claim_critic_verdicts.
 *
 * Idempotent: rows already at 'ai_reviewed' or higher are not
 * re-processed.
 *
 * Usage:
 *   node upgrade-claim-tier.js --dry-run
 *   node upgrade-claim-tier.js
 *   node upgrade-claim-tier.js --limit=10
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find(s => s.startsWith(`--${name}=`));
  if (!a) return args.includes(`--${name}`) ? true : def;
  return a.split('=', 2)[1];
}
const DRY_RUN = flag('dry-run', false) === true;
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;

const STAGING_ID_RE = /from staging row (\d+)/i;

(async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // 1. Pull all claims sitting at the single-vouch tier.
  let sql = `SELECT id, resolution_path, source_id, interaction_category, review_status FROM claims WHERE review_status = 'ai_vouched'`;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;
  const claims = await db.all(sql);
  console.log(`Found ${claims.length} claim rows at review_status='ai_vouched'.`);

  // 2. Extract staging_id for each.
  const claimsWithStagingId = [];
  let unparsable = 0;
  for (const c of claims) {
    const m = (c.resolution_path || '').match(STAGING_ID_RE);
    if (!m) { unparsable++; continue; }
    claimsWithStagingId.push({ claimId: c.id, stagingId: parseInt(m[1], 10) });
  }
  console.log(`  - parsable staging_id: ${claimsWithStagingId.length}`);
  console.log(`  - unparsable resolution_path: ${unparsable}`);

  if (claimsWithStagingId.length === 0) {
    await db.close();
    console.log('Nothing to upgrade.');
    return;
  }

  // 3. Compute consensus per staging_id.
  const stagingIds = [...new Set(claimsWithStagingId.map(x => x.stagingId))];
  const placeholders = stagingIds.map(() => '?').join(',');
  const consensus = await db.all(`
    SELECT staging_id,
           SUM(CASE WHEN verdict='plausible'   THEN 1 ELSE 0 END) AS p,
           SUM(CASE WHEN verdict='implausible' THEN 1 ELSE 0 END) AS i,
           SUM(CASE WHEN verdict='uncertain'   THEN 1 ELSE 0 END) AS u,
           SUM(CASE WHEN verdict='out_of_scope' THEN 1 ELSE 0 END) AS o,
           COUNT(*) AS total
    FROM claim_critic_verdicts
    WHERE staging_id IN (${placeholders})
    GROUP BY staging_id
  `, stagingIds);
  const consensusByStaging = new Map();
  for (const c of consensus) consensusByStaging.set(c.staging_id, c);

  // 4. Decide upgrade actions.
  const upgrades = [];
  const reasons = { upgrade: 0, no_verdicts: 0, insufficient_plausible: 0, has_implausible: 0 };
  for (const { claimId, stagingId } of claimsWithStagingId) {
    const c = consensusByStaging.get(stagingId);
    if (!c || c.total === 0) { reasons.no_verdicts++; continue; }
    if (c.i >= 1) { reasons.has_implausible++; continue; }
    if (c.p < 2) { reasons.insufficient_plausible++; continue; }
    upgrades.push({ claimId, stagingId, p: c.p, i: c.i, u: c.u, o: c.o });
    reasons.upgrade++;
  }

  console.log(`\nUpgrade decision rollup:`);
  for (const [k, n] of Object.entries(reasons)) console.log(`  ${k}: ${n}`);

  if (upgrades.length === 0) {
    await db.close();
    console.log('\nNo claims meet the consensus gate. Done.');
    return;
  }

  // 5. Apply upgrades.
  if (!DRY_RUN) {
    const upgradeIds = upgrades.map(u => u.claimId);
    const ph = upgradeIds.map(() => '?').join(',');
    const result = await db.run(`
      UPDATE claims
      SET review_status = 'ai_reviewed',
          reviewer_id = 'upgrade-claim-tier',
          reviewed_at = datetime('now')
      WHERE id IN (${ph}) AND review_status = 'ai_vouched'
    `, upgradeIds);
    console.log(`\nUpdated ${result.changes} claim rows to review_status='ai_reviewed'.`);
  } else {
    console.log(`\nWould upgrade ${upgrades.length} claim rows. (dry-run)`);
  }

  console.log('\n=== first 8 upgrades ===');
  for (const u of upgrades.slice(0, 8)) {
    console.log(`  claim_id=${u.claimId} ← staging=${u.stagingId} (p=${u.p}, i=${u.i}, u=${u.u}, o=${u.o})`);
  }

  await db.close();
  console.log('\nDone.');
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
