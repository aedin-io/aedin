'use strict';

const { traitToColumn, hasCacheColumn, ALL_CACHE_TRAITS } = require('./lib/trait-to-column');
const { loadVocabulary } = require('./lib/trait-vocabulary');
const { decodeTraitValue } = require('./lib/trait-value');

const PRECEDENCE = ['human_verified', 'edited', 'ai_reviewed', 'unreviewed'];
function rank(review_status, source_type) {
  if (review_status === 'human_verified' || review_status === 'edited') return 4;
  if (review_status === 'ai_reviewed') return source_type === 'api_sync' ? 2 : 3;
  return 1;
}

async function rebuildCache(db) {
  const vocab = await loadVocabulary(db);
  // For every (entity_id, trait_name) with at least one non-superseded reading,
  // pick canonical value and update entities column.
  const traitNames = ALL_CACHE_TRAITS;
  for (const trait of traitNames) {
    const v = vocab[trait];
    if (!v) continue;
    const col = traitToColumn(trait);
    if (!col) continue;
    const rows = await db.all(`
      SELECT etc.entity_id, etc.value_numeric, etc.value_text, etc.value_json,
             etc.review_status, etc.created_at, s.source_type, e.bio_category
      FROM entity_trait_claims etc
      JOIN sources s ON s.id = etc.source_id
      JOIN entities e ON e.id = etc.entity_id
      WHERE etc.trait_name = ? AND etc.superseded_by IS NULL
      ORDER BY etc.entity_id, etc.created_at DESC
    `, [trait]);
    const applicable = v.applicable_bio_categories || [];
    // Group by entity_id, pick highest-rank then latest
    const byEnt = new Map();
    for (const r of rows) {
      const cur = byEnt.get(r.entity_id);
      const cand = { row: r, rank: rank(r.review_status, r.source_type) };
      if (!cur || cand.rank > cur.rank) byEnt.set(r.entity_id, cand);
    }
    for (const [entity_id, { row }] of byEnt) {
      // Category guard: never promote a trait onto an entity whose bio_category
      // the trait doesn't apply to. Prevents recurrence of cross-category
      // contamination (e.g. a junk pest_mobility trait claim on a plant
      // re-populating entities.pest_mobility). See docs/data-hygiene-cross-category.md
      // + migration 043. The traits_vocabulary.applicable_bio_categories is the
      // source of truth.
      if (applicable.length && row.bio_category && !applicable.includes(row.bio_category)) {
        continue;
      }
      let value = decodeTraitValue(v, row);
      // List/range → store JSON string in TEXT column
      if (v.value_kind === 'range' || v.value_kind === 'list') {
        value = JSON.stringify(value);
      } else if (v.value_kind === 'boolean') {
        value = value ? 1 : 0;
      }
      await db.run(`UPDATE entities SET ${col} = ? WHERE id = ?`, [value, entity_id]);
    }
  }
  console.log('[rebuild-entity-cache] done.');
}

module.exports = { rebuildCache };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const DB_PATH = CORPUS_DB;
  (async () => {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await rebuildCache(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
