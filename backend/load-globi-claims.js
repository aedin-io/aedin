/**
 * load-globi-claims.js
 *
 * Transforms raw GloBI interactions (6.7M rows) into the unified claims table.
 * Each claim is a deduplicated (subject, object, interaction_type) triple with
 * aggregated interaction_count and locality_count.
 *
 * Prerequisites:
 *   - entities table populated (migration 008 + migrate-entities.js)
 *   - claims table created (migration 009)
 *
 * Usage:
 *   node load-globi-claims.js            # load (skips if claims exist)
 *   node load-globi-claims.js --force    # wipe claims and reload
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');
const { inferCategoryFromName } = require('./lib/entity-name-classification');
const { remapRow } = require('./lib/globi-interaction-remap');
const { isGarbage, FIXED_RULES, VARIABLE_TYPES, resolveVariable, assignMechanism, assignSeverity } = require('./lib/globi-classify');

const DB_PATH = CORPUS_DB;
const FORCE = process.argv.includes('--force');

// Exported for unit testing (load-globi-claims.test.js).
// Representative-citation model: SQLite's bare-column extension guarantees that
// when a query has exactly one MAX()/MIN(), the un-grouped columns are taken from
// that same row. So MAX(i.rowid) + bare i.reference_* yields an ALIGNED
// citation/doi/url triple from one record — the highest-rowid (last-ingested) one,
// a STABLE representative, NOT the most-cited/authoritative source. COUNT(DISTINCT
// reference_citation) gives the "+N other sources" tally; the GloBI record link
// surfaces the full list. (SQLite-specific; a non-SQLite backend would need a
// subquery join on _rep_rowid.) NOTE: interactions also stores dataset-level
// source_citation, which Phase A intentionally does NOT propagate to claims — the
// data is already there in interactions for Phase B to pick up.
const TRIPLES_SQL = `
    SELECT i.source_name, i.target_name, i.interaction_type,
           COALESCE(ilc.country, '') AS country,
           COALESCE(ilc.subdivision, '') AS subdivision,
           COUNT(*) AS cnt,
           COUNT(DISTINCT i.location) AS loc_cnt,
           MAX(i.rowid) AS rep_rowid
    FROM raw.interactions i
    LEFT JOIN raw.interaction_locality_coverage ilc
      ON ilc.source_name = i.source_name AND ilc.target_name = i.target_name
    WHERE i.source_name IS NOT NULL AND i.source_name != ''
      AND i.target_name IS NOT NULL AND i.target_name != ''
    GROUP BY i.source_name, i.target_name, i.interaction_type,
             COALESCE(ilc.country, ''), COALESCE(ilc.subdivision, '')
`;

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(ATTACH_RAW_SQL);
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -1048576;
    PRAGMA temp_store = FILE;
  `);

  const entCount = await db.get('SELECT COUNT(*) AS n FROM entities');
  if (!entCount || entCount.n === 0) {
    console.error('Error: entities table is empty. Run migrate-entities.js first.');
    await db.close();
    process.exit(1);
  }
  console.log(`Entities: ${entCount.n}`);

  const claimsExist = await db.get('SELECT COUNT(*) AS n FROM claims');
  if (FORCE) {
    console.log('Clearing existing claims...');
    await db.exec("DELETE FROM claims WHERE data_tier = 'tier2_globi'");
  }

  // Build dedup set for incremental mode
  const existingClaimKeys = new Set();
  if (!FORCE && claimsExist && claimsExist.n > 0) {
    console.log(`Claims table has ${claimsExist.n} rows. Running incremental (new triples only)...`);
    console.log('Loading existing claim keys for dedup...');
    const claimRows = await db.all(
      `SELECT subject_entity_id, object_entity_id, interaction_type_raw, country, subdivision FROM claims WHERE data_tier = 'tier2_globi'`
    );
    for (const c of claimRows) {
      existingClaimKeys.add(`${c.subject_entity_id}||${c.object_entity_id}||${c.interaction_type_raw}||${c.country}||${c.subdivision}`);
    }
    console.log(`  ${existingClaimKeys.size} existing claim keys loaded.\n`);
  }

  console.log('Building entity lookup...');
  const entityRows = await db.all(
    'SELECT id, scientific_name, primary_role, bio_category, family, nitrogen_fixation FROM entities'
  );
  const entityMap = new Map();
  for (const e of entityRows) {
    entityMap.set(e.scientific_name.toLowerCase(), e);
  }
  console.log(`  ${entityMap.size} entities in lookup.\n`);

  // Materialize the deduplicated triples into a DISK-backed table rather than
  // loading the whole result set into a JS array (which OOMs at 27.5M-row scale,
  // ~millions of triples with long citation strings). Combined with
  // temp_store=FILE, the GROUP BY sort spills to disk too — memory stays flat.
  // We then iterate the table in rowid-windowed batches (see below).
  console.log('Materializing deduplicated interaction triples to disk (this may take several minutes)...');
  await db.exec('DROP TABLE IF EXISTS _globi_triples');
  await db.exec('CREATE TABLE _globi_triples AS ' + TRIPLES_SQL);
  const totalTriples = (await db.get('SELECT COUNT(*) AS n FROM _globi_triples')).n;
  console.log(`  ${totalTriples} unique triples (with region) to process.\n`);

  // Prepare entity insert for auto-creation. bio_category/primary_role are
  // parameterised so name-based heuristics (see inferCategoryFromName) can set
  // them at insert time; falls back to 'other'/'unclassified' otherwise.
  const entityInsertStmt = await db.prepare(`
    INSERT OR IGNORE INTO entities (scientific_name, bio_category, primary_role, source_table, data_completeness, created_at, updated_at)
    VALUES (?, ?, ?, 'globi', 'minimal', datetime('now'), datetime('now'))
  `);

  const stmt = await db.prepare(`
    INSERT INTO claims (
      subject_entity_id, object_entity_id, data_tier,
      interaction_type_raw, interaction_category, effect_direction,
      confidence_score, applied_weight, evidence_tier,
      valence_confidence, resolution_path,
      mechanism, impact_class,
      interaction_count, locality_count,
      country, subdivision,
      reference_citation, reference_doi, reference_url, source_count
    ) VALUES (?, ?, 'tier2_globi', ?, ?, ?, ?, ?, 'inferred', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0, skippedNoEntity = 0, skippedGarbage = 0, skippedNeutral = 0, skippedDuplicate = 0, entitiesCreated = 0;

  async function getOrCreateEntity(name) {
    const key = name.toLowerCase();
    let entity = entityMap.get(key);
    if (entity) return entity;

    // Apply name-based heuristics (currently: virus/phage/viroid → microbe).
    const inferred = inferCategoryFromName(name) || { bio_category: 'other', primary_role: 'unclassified' };
    await entityInsertStmt.run(name, inferred.bio_category, inferred.primary_role);
    const row = await db.get('SELECT id, scientific_name, primary_role, bio_category, family, nitrogen_fixation FROM entities WHERE scientific_name = ? COLLATE NOCASE', [name]);
    if (row) {
      entityMap.set(key, row);
      entitiesCreated++;
      return row;
    }
    return null;
  }
  const categoryCounts = {};

  await db.exec('BEGIN');

  const TRIPLE_BATCH = 25000;
  let _lastRid = 0, _processed = 0;
  while (true) {
    // Pull the representative citation via a fast rowid JOIN here, NOT inside the
    // GROUP BY — carrying citation strings through the 27.5M-row sort made the
    // materialize pathologically slow (multi-pass merge of an ~8GB payload). The
    // GROUP BY now only carries the integer rep_rowid; this PK-join is cheap.
    const triples = await db.all(
      `SELECT t.rowid AS _rid, t.*,
              i.reference_citation AS ref_citation,
              i.reference_doi      AS ref_doi,
              i.reference_url      AS ref_url
       FROM _globi_triples t
       LEFT JOIN raw.interactions i ON i.rowid = t.rep_rowid
       WHERE t.rowid > ? ORDER BY t.rowid LIMIT ?`,
      [_lastRid, TRIPLE_BATCH]
    );
    if (triples.length === 0) break;
    for (const t of triples) {
    if (isGarbage(t.source_name) || isGarbage(t.target_name)) {
      skippedGarbage++;
      continue;
    }

    const src = await getOrCreateEntity(t.source_name);
    const tgt = await getOrCreateEntity(t.target_name);
    if (!src || !tgt) {
      skippedNoEntity++;
      continue;
    }

    const itype = t.interaction_type || '';

    // Incremental dedup
    if (existingClaimKeys.size > 0) {
      const claimKey = `${src.id}||${tgt.id}||${itype}||${t.country}||${t.subdivision}`;
      if (existingClaimKeys.has(claimKey)) {
        skippedDuplicate++;
        continue;
      }
    }
    let category, effect, weight, valenceConf, resPath;

    const fixedRule = FIXED_RULES[itype];
    if (fixedRule) {
      category = fixedRule.category;
      effect = fixedRule.effect;
      weight = fixedRule.weight;
      valenceConf = 'direct';
      resPath = `Fixed: ${itype} → ${effect}`;
    } else if (VARIABLE_TYPES.has(itype)) {
      const res = resolveVariable(itype, src, tgt);
      category = res.category;
      effect = res.effect;
      weight = res.weight;
      valenceConf = res.confidence;
      resPath = res.path;
    } else {
      category = 'facilitation';
      effect = 'neutral';
      weight = 0;
      valenceConf = 'direct';
      resPath = `Unknown type: ${itype}`;
    }

    // ── GloBI semantic remap (Phase F — permanent ingest filter) ─────────────
    // Apply the same correction rules used in the Phase-C backfill so new GloBI
    // rows self-correct at load time. Single source of truth:
    // lib/globi-interaction-remap.js (docs/globi-semantic-cleanup-plan.md).
    let subjectId = src.id, objectId = tgt.id;
    let confidence = 0.5;
    const remapped = remapRow({
      subject_bio_category: src.bio_category, subject_family: src.family,
      subject_scientific_name: src.scientific_name,
      object_bio_category: tgt.bio_category, object_family: tgt.family,
      raw_interaction_type: itype,
      interaction_category: category, effect_direction: effect,
    });
    if (remapped) {
      if (remapped.action === 'flip') { subjectId = tgt.id; objectId = src.id; }
      category = remapped.category;
      effect = remapped.effect_direction;
      confidence = 0.5 * (remapped.confidence_modifier == null ? 1.0 : remapped.confidence_modifier);
    }

    if (weight === 0 && effect === 'neutral') {
      skippedNeutral++;
      continue;
    }

    const mechanism = assignMechanism(itype, effect, category);
    const severity = assignSeverity(mechanism, weight);

    await stmt.run(
      subjectId, objectId,
      itype, category, effect,
      confidence, weight, valenceConf, resPath,
      mechanism, severity,
      t.cnt, t.loc_cnt,
      t.country, t.subdivision,
      t.ref_citation || null, t.ref_doi || null, t.ref_url || null, 0
    );

    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    inserted++;

    if (inserted % 50000 === 0) {
      await db.exec('COMMIT');
      await db.exec('BEGIN');
      console.log(`  Inserted ${inserted}...`);
    }
    } // end inner for (batch)
    _lastRid = triples[triples.length - 1]._rid;
    _processed += triples.length;
    if (_processed % 500000 === 0) {
      console.log(`  triples processed: ${_processed.toLocaleString()}/${totalTriples.toLocaleString()}`);
    }
  } // end while (batched triple reader)

  await db.exec('COMMIT');
  await db.exec('DROP TABLE IF EXISTS _globi_triples');
  await stmt.finalize();
  await entityInsertStmt.finalize();

  console.log(`\n=== Summary ===`);
  console.log(`Total triples:   ${totalTriples}`);
  console.log(`Entities created:    ${entitiesCreated}`);
  console.log(`Inserted:        ${inserted}`);
  console.log(`Skipped (no entity): ${skippedNoEntity}`);
  console.log(`Skipped (garbage):   ${skippedGarbage}`);
  console.log(`Skipped (duplicate):   ${skippedDuplicate}`);
  console.log(`Skipped (neutral):   ${skippedNeutral}`);
  console.log(`\nBy category:`);
  for (const [cat, count] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  await db.close();
  console.log('\nDone.');
}

module.exports = { TRIPLES_SQL };

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
