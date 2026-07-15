#!/usr/bin/env node
'use strict';

/**
 * dedup-varieties.js — report-only: lists near-duplicate variety candidate pairs.
 *
 * For each parent_entity_id that has ≥2 variety children where at least one
 * has needs_dedup=1, prints candidate pairs with Levenshtein distance ≤ distCap
 * and length-ratio ≤ ratioCap. NO automatic merges — a human curator adjudicates
 * candidates in the admin UI (Varieties tab).
 *
 * Usage:
 *   node dedup-varieties.js               # print candidate report
 *   node dedup-varieties.js --dist-cap=3  # tune distance threshold
 */

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { computeCandidates } = require('./lib/merge-variety');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

async function dedupOnce(db, opts = {}) {
  const candidates = await computeCandidates(db, opts);
  const pairCount = candidates.reduce((n, g) => n + g.pairs.length, 0);
  console.log(`[dedup] ${pairCount} candidate pair(s) across ${candidates.length} parent(s). ` +
    `Human-gated: review + approve in the admin (Varieties tab). No automatic merges.`);
  return { candidates, pairCount };
}

module.exports = { dedupOnce };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const distCapArg = argv.find(a => a.startsWith('--dist-cap='));
  const distCap = distCapArg ? parseInt(distCapArg.split('=')[1], 10) : undefined;
  const DB_PATH = CORPUS_DB;
  (async () => {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.run('PRAGMA busy_timeout = 30000');
    const { candidates } = await dedupOnce(db, distCap !== undefined ? { distCap } : {});
    for (const group of candidates) {
      console.log(`\nParent: ${group.parent.name} (id=${group.parent.id})`);
      for (const p of group.pairs) {
        console.log(`  pair a=${p.a} b=${p.b} dist=${p.levenshtein} suggestedCanonical=${p.suggestedCanonicalId} claimCounts=${p.aClaimCount}/${p.bClaimCount}`);
      }
    }
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
