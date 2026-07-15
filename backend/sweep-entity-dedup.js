'use strict';

const { levenshtein } = require('./lib/levenshtein');

const EPITHET_MAX_DISTANCE = 2;

function isAnchored(e) { return !!(e.grin_accession || e.gbif_key); }

/** Canonical = the anchored one; null when both (or neither) anchored => human picks. */
function pickCanonical(a, b) {
  const aa = isAnchored(a), ba = isAnchored(b);
  if (aa && !ba) return a.id;
  if (ba && !aa) return b.id;
  if (!aa && !ba) return a.id < b.id ? a.id : b.id; // deterministic: lower id
  return null; // both anchored
}

function epithet(scientificName) {
  const parts = String(scientificName || '').trim().split(/\s+/);
  return (parts[1] || '').toLowerCase();
}

/**
 * Genus-block the entities table, compare species epithets pairwise within
 * each block, flag Levenshtein <= 2 pairs (excluding distance 0 = same name)
 * into entity_dedup_candidates. Skips already-tombstoned rows. Returns the
 * number of new candidate rows inserted.
 */
async function sweepDedup(db) {
  const rows = await db.all(
    `SELECT id, scientific_name, genus, grin_accession, gbif_key
       FROM entities WHERE merged_into_entity_id IS NULL AND genus IS NOT NULL`
  );
  const byGenus = new Map();
  for (const e of rows) {
    const g = (e.genus || '').toLowerCase();
    if (!g) continue;
    if (!byGenus.has(g)) byGenus.set(g, []);
    byGenus.get(g).push(e);
  }

  let inserted = 0;
  for (const [, group] of byGenus) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const d = levenshtein(epithet(a.scientific_name), epithet(b.scientific_name), EPITHET_MAX_DISTANCE + 1);
        if (d === 0 || d > EPITHET_MAX_DISTANCE) continue;
        const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
        const canonical = pickCanonical(a, b);
        const res = await db.run(
          `INSERT OR IGNORE INTO entity_dedup_candidates
             (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id)
           VALUES (?, ?, ?, ?, 'species_epithet', ?)`,
          lo, hi, a.genus, d, canonical
        );
        if (res.changes > 0) inserted++;
      }
    }
  }
  return inserted;
}

module.exports = { sweepDedup, pickCanonical, isAnchored, epithet };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const DB_PATH = CORPUS_DB;
  (async () => {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    const n = await sweepDedup(db);
    console.log(`[sweep-entity-dedup] flagged ${n} new candidate pairs.`);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
