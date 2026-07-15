'use strict';

const Database = require('better-sqlite3');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');
const { parseGbifKey } = require('./lib/globi-taxon-ids');
const { bioCategoryFromLineage } = require('./lib/bio-category-from-lineage');

const UNCLASSIFIED = new Set(['other', '', null, undefined]);

function buildResolutionMap(db) {
  const tally = new Map(); // name -> Map<gbifKey, { count, lineage, firstRowid }>
  const sql = `
    SELECT lower(source_name) AS name, source_taxon_ids AS ids, rowid AS rid,
           source_kingdom AS kingdom, source_phylum AS phylum, source_class AS cls,
           source_order AS ord, source_family AS family, source_genus AS genus
      FROM raw.interactions WHERE source_taxon_ids IS NOT NULL
    UNION ALL
    SELECT lower(target_name) AS name, target_taxon_ids AS ids, rowid AS rid,
           target_kingdom, target_phylum, target_class, target_order, target_family, target_genus
      FROM raw.interactions WHERE target_taxon_ids IS NOT NULL
  `;
  for (const row of db.prepare(sql).iterate()) {
    const key = parseGbifKey(row.ids);
    if (key == null || !row.name) continue;
    let keyMap = tally.get(row.name);
    if (!keyMap) { keyMap = new Map(); tally.set(row.name, keyMap); }
    const ex = keyMap.get(key);
    if (ex) { ex.count++; if (row.rid < ex.firstRowid) ex.firstRowid = row.rid; }
    else {
      keyMap.set(key, {
        count: 1, firstRowid: row.rid,
        lineage: { kingdom: row.kingdom, phylum: row.phylum, taxon_class: row.cls,
                   taxon_order: row.ord, family: row.family, genus: row.genus },
      });
    }
  }
  const resolved = new Map();
  for (const [name, keyMap] of tally) {
    let best = null;
    for (const [key, info] of keyMap) {
      if (best === null
          || info.count > best.count
          || (info.count === best.count && info.firstRowid < best.firstRowid)) {
        best = { key, count: info.count, firstRowid: info.firstRowid, lineage: info.lineage };
      }
    }
    resolved.set(name, { key: best.key, lineage: best.lineage });
  }
  return resolved;
}

function resolveEntities(db, { force = false, dryRun = false } = {}) {
  const resolved = buildResolutionMap(db);
  const histogram = { globi_keyed: 0, fallback_no_match: 0, key_disagreements: 0 };
  let updated = 0;

  const update = db.prepare(`
    UPDATE entities SET gbif_key=?, kingdom=?, phylum=?, taxon_class=?, taxon_order=?,
      family=?, genus=?, bio_category=?, lineage_source='globi' WHERE id=?
  `);

  const entities = db.prepare('SELECT id, scientific_name, bio_category, gbif_key FROM entities').all();
  for (const e of entities) {
    const hit = e.scientific_name ? resolved.get(e.scientific_name.toLowerCase()) : null;
    if (!hit) { histogram.fallback_no_match++; continue; }
    histogram.globi_keyed++;
    if (e.gbif_key != null && e.gbif_key !== hit.key) {
      histogram.key_disagreements++;
      console.log(`[resolve] disagreement entity=${e.id} old=${e.gbif_key} new=${hit.key} (${e.scientific_name})`);
    }
    if (!force && e.gbif_key != null) continue; // incremental: fill nulls only
    if (dryRun) continue;
    const l = hit.lineage;
    const bio = UNCLASSIFIED.has(e.bio_category)
      ? bioCategoryFromLineage({ kingdom: l.kingdom, phylum: l.phylum, class: l.taxon_class })
      : e.bio_category;
    update.run(hit.key, l.kingdom, l.phylum, l.taxon_class, l.taxon_order, l.family, l.genus, bio, e.id);
    updated++;
  }
  return { histogram, updated };
}

module.exports = { resolveEntities, buildResolutionMap };

if (require.main === module) {
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const db = new Database(CORPUS_DB);
  db.exec(ATTACH_RAW_SQL);
  const { histogram, updated } = resolveEntities(db, { force, dryRun });
  console.log(`[resolve-entities-from-globi]${dryRun ? ' DRY-RUN' : ''} histogram:`, JSON.stringify(histogram), `updated=${updated}`);
  db.close();
}
