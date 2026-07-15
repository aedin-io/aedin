'use strict';

const { resolveEntity } = require('./lib/entity-resolver');

/** Worst-of the two per-side statuses (verified > fuzzy_verified > unverified). */
function combineStatus(a, b) {
  const rank = { verified: 2, fuzzy_verified: 1, unverified: 0 };
  return rank[a] <= rank[b] ? a : b;
}

/** Pull the organism/crop string for one side from the staged payload. */
function sideName(payload, side) {
  return payload[`${side}_organism`] || payload[`${side}_crop`] || payload[`${side}_common_name`] || '';
}

/** Genus-blocked slice: entities whose genus matches the name's first token. */
function sliceFor(name, allEntities) {
  const genus = String(name || '').trim().split(/\s+/)[0].toLowerCase();
  if (!genus) return [];
  return allEntities.filter(e => (e.genus || '').toLowerCase() === genus
    || (e.scientific_name || '').toLowerCase().startsWith(genus + ' '));
}

/**
 * Resolve subject + object for every staging row lacking entity_resolution_status.
 * Writes entity_resolution_status + resolved_*_entity_id. Returns rows updated.
 */
async function resolveStagingRows(db) {
  const allEntities = await db.all(`SELECT id, scientific_name, common_name, synonyms, genus FROM entities`);
  const rows = await db.all(
    `SELECT id, payload FROM extraction_staging
     WHERE target_table = 'claims' AND entity_resolution_status IS NULL`
  );
  let updated = 0;
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    const subjName = sideName(payload, 'subject');
    const objName = sideName(payload, 'object');
    const subj = resolveEntity(subjName, { entities: sliceFor(subjName, allEntities) });
    const obj = resolveEntity(objName, { entities: sliceFor(objName, allEntities) });
    const status = combineStatus(subj.status, obj.status);
    await db.run(
      `UPDATE extraction_staging
         SET entity_resolution_status = ?, resolved_subject_entity_id = ?, resolved_object_entity_id = ?
       WHERE id = ?`,
      status, subj.entity_id, obj.entity_id, row.id
    );
    updated++;
  }
  return updated;
}

module.exports = { resolveStagingRows, combineStatus, sideName, sliceFor };

if (require.main === module) {
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const DB_PATH = CORPUS_DB;
  (async () => {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    const n = await resolveStagingRows(db);
    console.log(`[postrag-resolve] resolved ${n} staging rows.`);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
