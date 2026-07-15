#!/usr/bin/env node
'use strict';

/**
 * sync-wikidata-uses.js — pulls Wikidata P366 ("has use") values for plant
 * entities and writes them to entities.agronomic_uses (migration 040).
 *
 * Multi-valued: each plant gets a JSON array of canonical tags from
 * lib/agronomic-uses.js. Empty array `[]` means "we asked Wikidata and it
 * had no usable values" (NULL means "not yet synced").
 *
 * Source:
 *   Wikidata SPARQL endpoint, joining on P225 (taxon name) to match our
 *   entities.scientific_name. 100% coverage measured on the top-23 crops
 *   during the design pass — Wikidata is well-curated for cultivated /
 *   ornamental / medicinal plant uses.
 *
 * Match scope:
 *   bio_category='plantae' AND agronomic_uses IS NULL (default).
 *   --force re-syncs all plantae.
 *   --actionable limits to plants participating in ai_reviewed claims.
 *
 * Usage:
 *   node sync-wikidata-uses.js                  # backfill unsynced plantae
 *   node sync-wikidata-uses.js --actionable     # only ai_reviewed-participating plants
 *   node sync-wikidata-uses.js --force          # re-sync everything
 *   node sync-wikidata-uses.js --limit=100      # cap rows processed
 *   node sync-wikidata-uses.js --dry-run        # print updates, don't write
 */

const Database = require('better-sqlite3');
const { tagsFromWikidata } = require('./lib/agronomic-uses');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 1500;
const UA = 'aedin-wikidata-uses-sync/0.1 (contact@aedin.io)';

const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');
const ACTIONABLE = process.argv.includes('--actionable');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Generate the set of name variants to try for a given scientific_name.
// Wikidata's P225 values follow strict botanical conventions which often
// don't match our DB's looser strings:
//   - hybrids: "Fragaria x ananassa" (ASCII x) vs "Fragaria × ananassa" (Unicode ×)
//   - genus-spp: "Amaranthus spp." (our convention) vs "Amaranthus" (Wikidata's)
//   - var./subsp. suffixes: "Brassica oleracea var. capitata" → strip to "Brassica oleracea"
// The returned array is the original name first, then ordered fallbacks.
function nameVariants(scientificName) {
  const variants = new Set([scientificName]);
  // Hybrid character normalization (both directions)
  if (/ x /.test(scientificName)) variants.add(scientificName.replace(/ x /g, ' × '));
  if (/ × /.test(scientificName)) variants.add(scientificName.replace(/ × /g, ' x '));
  // Genus-only fallback for " spp." entries
  if (/ spp\.?$/i.test(scientificName)) variants.add(scientificName.replace(/ spp\.?$/i, '').trim());
  // Drop var. / subsp. / cultivar suffixes — keep first two tokens
  const stripped = scientificName.replace(/\s+(var|subsp|cv|f)\.?\s+.*$/i, '').trim();
  if (stripped && stripped !== scientificName) variants.add(stripped);
  // Strip taxonomic authority (e.g. "L." or "(Mill.) Pers.") — keep first two tokens
  const parts = scientificName.split(/\s+/);
  if (parts.length > 2 && /^[A-Z]/.test(parts[0]) && /^[a-z]/.test(parts[1])) {
    variants.add(parts.slice(0, 2).join(' '));
  }
  return [...variants];
}

async function sparqlBatch(names) {
  const values = names.map(n => `"${n.replace(/"/g, '\\"')}"`).join(' ');
  const query = `
    SELECT ?taxonName ?useLabel WHERE {
      VALUES ?taxonName { ${values} }
      ?taxon wdt:P225 ?taxonName .
      ?taxon wdt:P366 ?use .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `.trim();
  const url = `${SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
  const data = await res.json();
  // Group results by taxonName
  const byName = new Map();
  for (const row of data.results.bindings) {
    const n = row.taxonName.value;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(row.useLabel.value);
  }
  return byName;
}

async function main() {
  const db = new Database(DB_PATH);

  // Build the row set
  let sql = `SELECT id, scientific_name FROM entities WHERE bio_category='plantae' AND scientific_name IS NOT NULL`;
  if (!FORCE) sql += ` AND agronomic_uses IS NULL`;
  if (ACTIONABLE) {
    sql += ` AND id IN (
      SELECT subject_entity_id FROM claims WHERE review_status='ai_reviewed'
      UNION
      SELECT object_entity_id FROM claims WHERE review_status='ai_reviewed' AND object_entity_id IS NOT NULL
    )`;
  }
  sql += ` ORDER BY id`;
  if (LIMIT > 0) sql += ` LIMIT ${LIMIT}`;
  const rows = db.prepare(sql).all();

  console.log(`[sync-wikidata-uses] ${rows.length} plant entities to sync ${ACTIONABLE ? '(actionable subset)' : ''} ${DRY ? '[dry-run]' : ''}`);
  if (!rows.length) { db.close(); return; }

  const update = db.prepare(`UPDATE entities SET agronomic_uses = ? WHERE id = ?`);

  let touched = 0, hitCount = 0, totalTags = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    // Build a variant-list per row, then send all variants in one SPARQL query.
    const rowVariants = batch.map(r => ({ row: r, variants: nameVariants(r.scientific_name) }));
    const queryNames = [...new Set(rowVariants.flatMap(rv => rv.variants))];
    let batchHits;
    try {
      batchHits = await sparqlBatch(queryNames);
    } catch (err) {
      console.error(`[sync-wikidata-uses] batch ${i}–${i + batch.length} failed: ${err.message}`);
      await sleep(RATE_LIMIT_MS * 2);
      continue;
    }

    for (const { row: r, variants } of rowVariants) {
      // Take the first variant that returned ≥1 use label
      let labels = [];
      for (const v of variants) {
        const hit = batchHits.get(v);
        if (hit && hit.length) { labels = hit; break; }
      }
      const tags = tagsFromWikidata(labels);
      if (DRY) {
        if (tags.length) console.log(`  [dry] ${r.scientific_name} → [${tags.join(', ')}]`);
      } else {
        update.run(JSON.stringify(tags), r.id);
      }
      touched++;
      if (tags.length) { hitCount++; totalTags += tags.length; }
    }

    if ((i / BATCH_SIZE) % 5 === 4) {
      console.log(`  ...${touched}/${rows.length} processed, ${hitCount} with ≥1 tag`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[sync-wikidata-uses] done — ${touched} processed, ${hitCount} tagged (${(hitCount/touched*100).toFixed(1)}%), avg ${(totalTags/Math.max(1,hitCount)).toFixed(2)} tags/plant`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
