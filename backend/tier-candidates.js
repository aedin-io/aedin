'use strict';
// Backfill entity_dedup_candidates.tier (+ refresh suggested_canonical_id) for
// every pending candidate, using the pure classifier lib/dedup-tier.js.
const { tierOf, pickCanonicalForDedup } = require('./lib/dedup-tier');

async function hydrate(db, id) {
  const e = await db.get(`SELECT id, scientific_name, gbif_key, scope_tier FROM entities WHERE id=?`, id);
  if (!e) return null;
  e.claim_count = (await db.get(
    `SELECT COUNT(*) n FROM claims WHERE subject_entity_id=? OR object_entity_id=?`, [id, id])).n;
  e.trait_count = (await db.get(`SELECT COUNT(*) n FROM entity_trait_claims WHERE entity_id=?`, [id])).n;
  return e;
}

async function tierAllCandidates(db) {
  const rows = await db.all(`SELECT id, entity_a_id, entity_b_id, levenshtein_distance FROM entity_dedup_candidates WHERE status='pending'`);
  const hist = { auto_safe: 0, needs_review: 0, domain: 0 };
  for (const r of rows) {
    const a = await hydrate(db, r.entity_a_id), b = await hydrate(db, r.entity_b_id);
    if (!a || !b) continue; // tombstoned/missing endpoint — skip
    const tier = tierOf(a, b, { levenshtein_distance: r.levenshtein_distance });
    const canon = pickCanonicalForDedup(a, b);
    await db.run(`UPDATE entity_dedup_candidates SET tier=?, suggested_canonical_id=? WHERE id=?`, [tier, canon, r.id]);
    hist[tier] = (hist[tier] || 0) + 1;
  }
  return hist;
}

module.exports = { tierAllCandidates };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    const h = await tierAllCandidates(db);
    console.log(`[tier-candidates] auto_safe=${h.auto_safe} needs_review=${h.needs_review} domain=${h.domain}`);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
