'use strict';
// Subscription-only dedup review: pull pending entity_dedup_candidates without a
// verdict yet, route each to one specialty critic, write batch JSON for a Claude
// Code Agent to fill. Mirrors multi-critic-batch-prepare.js. Resumable.
const fs = require('fs');
const path = require('path');
const { routeDedupCritic, composeDedupPrompt } = require('./lib/dedup-critic-prompts');

async function hydrate(db, id) {
  const e = await db.get(`SELECT id, scientific_name, bio_category, taxonomy_path AS taxon_path, gbif_key FROM entities WHERE id=?`, id);
  if (!e) return null;
  e.claims = (await db.get(`SELECT COUNT(*) n FROM claims WHERE subject_entity_id=? OR object_entity_id=?`, [id, id])).n;
  return e;
}

async function prepareBatches(db, { batchSize = 12, maxRows = 999999, tier = null, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {                 // wipe stale batches
    if (f.startsWith('batch-') && f.endsWith('.json')) fs.unlinkSync(path.join(outDir, f));
  }
  const tierClause = tier ? ` AND c.tier = ?` : '';
  const params = tier ? [tier, maxRows] : [maxRows];
  const cands = await db.all(
    `SELECT c.id, c.entity_a_id, c.entity_b_id, c.suggested_canonical_id, c.tier
       FROM entity_dedup_candidates c
      WHERE c.status='pending'${tierClause}
        AND NOT EXISTS (SELECT 1 FROM entity_dedup_verdicts v WHERE v.candidate_id = c.id)
      ORDER BY c.id LIMIT ?`, params);

  const pairs = [];
  for (const c of cands) {
    const a = await hydrate(db, c.entity_a_id), b = await hydrate(db, c.entity_b_id);
    if (!a || !b) continue;
    const critic = routeDedupCritic(a, b);
    const { systemPrompt, body, model } = composeDedupPrompt(critic, {
      candidate_id: c.id,
      a_id: a.id, a_name: a.scientific_name, a_gbif: a.gbif_key, a_path: a.taxon_path, a_claims: a.claims,
      b_id: b.id, b_name: b.scientific_name, b_gbif: b.gbif_key, b_path: b.taxon_path, b_claims: b.claims,
      suggested_canonical_id: c.suggested_canonical_id,
    });
    pairs.push({ candidate_id: c.id, critic, system_prompt: systemPrompt, model, body });
  }

  let batchId = 0;
  for (let i = 0; i < pairs.length; i += batchSize) {
    const slice = pairs.slice(i, i + batchSize);
    fs.writeFileSync(path.join(outDir, `batch-${String(batchId).padStart(3, '0')}.json`),
      JSON.stringify({ batch_id: batchId, pairs: slice }, null, 2));
    batchId++;
  }
  return { batches: batchId, pairs: pairs.length };
}

module.exports = { prepareBatches };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.split('=', 2)[1] : d; };
  const batchSize = parseInt(flag('batch-size', '12'), 10) || 12;
  const maxRows = parseInt(flag('max-rows', '999999'), 10) || 999999;
  const tier = flag('tier', '') || null;
  const outDir = process.env.BATCH_OUT_DIR || path.join(__dirname, 'dedup-review-batches');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    const r = await prepareBatches(db, { batchSize, maxRows, tier, outDir });
    console.log(`[dedup-prepare] ${r.pairs} pairs → ${r.batches} batches in ${outDir}${tier ? ` (tier=${tier})` : ''}`);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
