'use strict';
// Emit domain-tier + auto_safe-sample review artifacts, then (under --apply,
// after the domain gate) merge every auto_safe candidate via the reversible
// merge-entity rail, writing a revision_log row + returning the loser ids for a
// JSON backup. domain/needs_review tiers are left bucketed.
const fs = require('fs');
const path = require('path');
const { mergeCandidate } = require('./merge-entity');

async function fetchPairs(db, tier) {
  return db.all(
    `SELECT c.id AS candidate_id, c.entity_a_id AS a_id, c.entity_b_id AS b_id,
            c.suggested_canonical_id, c.match_basis,
            ea.scientific_name AS a_name, eb.scientific_name AS b_name
       FROM entity_dedup_candidates c
       JOIN entities ea ON ea.id=c.entity_a_id
       JOIN entities eb ON eb.id=c.entity_b_id
      WHERE c.tier=? AND c.status='pending'
      ORDER BY c.id`, [tier]);
}

async function emitReviewArtifacts(db, { sampleSize = 40 } = {}) {
  const domain = await fetchPairs(db, 'domain');
  const all = await fetchPairs(db, 'auto_safe');
  // Stratified-ish sample: spread across the list by even stride.
  let sample;
  if (all.length <= sampleSize) sample = all;
  else {
    const stride = Math.ceil(all.length / sampleSize);
    sample = all.filter((_, i) => i % stride === 0).slice(0, sampleSize);
  }
  return { domain, sample };
}

async function drainAutoSafe(db, { apply = false, reviewerId = 'drain-auto-safe' } = {}) {
  const rows = await db.all(
    `SELECT id FROM entity_dedup_candidates WHERE tier='auto_safe' AND status='pending' ORDER BY id`);
  const losers = [];
  let claimsMoved = 0, traitsMoved = 0;
  for (const { id } of rows) {
    if (!apply) continue; // dry-run: count only
    const r = await mergeCandidate(db, id, { reviewer_id: reviewerId });
    losers.push(r.merged_id);
    claimsMoved += r.claims_updated;
    traitsMoved += r.trait_claims_updated;
    await db.run(
      `INSERT INTO revision_log (target_type, target_id, field, before_value, after_value, changed_by, method)
       VALUES ('entity', ?, 'merged_into_entity_id', NULL, ?, 'drain-auto-safe', 'entity_dedup_merge')`,
      [r.merged_id, String(r.canonical_id)]);
  }
  return { merged: rows.length, claimsMoved, traitsMoved, losers: apply ? losers : [] };
}

module.exports = { emitReviewArtifacts, drainAutoSafe };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const apply = process.argv.includes('--apply');
  const reviewDir = path.join(__dirname, 'dedup-review');
  const backupDir = path.join(__dirname, 'backups');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    const { domain, sample } = await emitReviewArtifacts(db);
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'domain-pairs.json'), JSON.stringify(domain, null, 2));
    fs.writeFileSync(path.join(reviewDir, 'auto-safe-sample.json'), JSON.stringify(sample, null, 2));
    console.log(`[drain] review artifacts: ${domain.length} domain pairs, ${sample.length} auto_safe sample -> backend/dedup-review/`);
    if (!apply) {
      const dry = await drainAutoSafe(db, { apply: false });
      console.log(`[drain] DRY RUN — ${dry.merged} auto_safe candidates would merge. Review the artifacts, then re-run with --apply.`);
      await db.close();
      return;
    }
    // --apply: back up loser rows first, then drain.
    const auto = await db.all(`SELECT c.id, c.entity_a_id, c.entity_b_id, c.suggested_canonical_id
      FROM entity_dedup_candidates c WHERE c.tier='auto_safe' AND c.status='pending'`);
    const loserIds = auto.map(c => (c.entity_a_id === c.suggested_canonical_id ? c.entity_b_id : c.entity_a_id));
    const loserRows = loserIds.length
      ? await db.all(`SELECT * FROM entities WHERE id IN (${loserIds.map(() => '?').join(',')})`, loserIds)
      : [];
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, `dedup-auto-safe-losers-${stamp}.json`), JSON.stringify(loserRows, null, 2));
    const res = await drainAutoSafe(db, { apply: true });
    console.log(`[drain] merged ${res.merged} auto_safe pairs (${res.claimsMoved} claims, ${res.traitsMoved} trait-claims moved). Backup: ${loserRows.length} loser rows.`);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
