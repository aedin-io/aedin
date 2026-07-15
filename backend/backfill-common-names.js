'use strict';
// Resumable backfill: for each served entity not yet synced, fetch GBIF vernacular
// names + Wikidata P1843 names (all languages), upsert into entity_common_names,
// then mark entities.common_names_synced_at. Re-run resumes where it stopped.
const Database = require('better-sqlite3');
const path = require('path');
const { gbifVernacularRecords, wikidataCommonNameRecords } = require('./lib/vernacular-sources');
const { upsertName } = require('./lib/common-name-upsert');

const GBIF_API = 'https://api.gbif.org/v1';
const WD_SPARQL = 'https://query.wikidata.org/sparql';
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const DB_PATH = CORPUS_DB;
const DELAY_MS = 150;           // polite throttle between entities
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'AEDIN/1.0 (common-names backfill)' }, ...opts });
      if (res.status === 429 || res.status >= 500) throw new Error('retryable ' + res.status);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (i === tries - 1) return null;
      await sleep(500 * (i + 1));
    }
  }
  return null;
}

async function gbifNames(gbifKey) {
  if (gbifKey == null) return [];
  const data = await fetchJson(`${GBIF_API}/species/${gbifKey}/vernacularNames?limit=100`);
  return gbifVernacularRecords(data && data.results);
}

async function wikidataNames(scientificName) {
  // P1843 (taxon common name) in ALL languages for the taxon matched by name.
  const q = `SELECT ?item ?commonName WHERE {
    ?item wdt:P225 "${scientificName.replace(/"/g, '\\"')}" .
    ?item wdt:P1843 ?commonName .
  } LIMIT 200`;
  const data = await fetchJson(`${WD_SPARQL}?format=json&query=${encodeURIComponent(q)}`);
  const bindings = data && data.results && data.results.bindings;
  const qid = bindings && bindings[0] && bindings[0].item && bindings[0].item.value.split('/').pop();
  return wikidataCommonNameRecords(bindings, qid);
}

async function main() {
  const limit = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || null;
  const db = new Database(DB_PATH);
  // Served set: subject/object of an ai_reviewed claim OR scope_tier set (mirrors build-d1).
  const served = db.prepare(`
    SELECT id, scientific_name, gbif_key FROM entities
    WHERE common_names_synced_at IS NULL
      AND (scope_tier IS NOT NULL
           OR id IN (SELECT subject_entity_id FROM claims WHERE review_status='ai_reviewed')
           OR id IN (SELECT object_entity_id  FROM claims WHERE review_status='ai_reviewed')
           OR id IN (SELECT entity_id FROM entity_trait_claims WHERE review_status='ai_reviewed'))
    ORDER BY id ${limit ? 'LIMIT ' + limit : ''}
  `).all();
  console.log(`backfill: ${served.length} served entities pending`);
  const mark = db.prepare("UPDATE entities SET common_names_synced_at = datetime('now') WHERE id = ?");

  let done = 0;
  let errors = 0;
  for (const e of served) {
    try {
      const recs = [].concat(await gbifNames(e.gbif_key), e.scientific_name ? await wikidataNames(e.scientific_name) : []);
      const tx = db.transaction(() => {
        for (const r of recs) upsertName(db, e.id, r);
        mark.run(e.id);
      });
      tx();
      done++;
    } catch (err) {
      errors++;
      console.warn(`  [error] entity ${e.id} (${e.scientific_name}): ${err.message}`);
    }
    if ((done + errors) % 100 === 0) console.log(`  ${done} done / ${errors} errors / ${served.length} total`);
    await sleep(DELAY_MS);
  }
  console.log(`backfill complete: ${done} entities, ${errors} errors, ${db.prepare('SELECT COUNT(*) n FROM entity_common_names').get().n} names total`);
  db.close();
}

if (require.main === module) main();
module.exports = { gbifNames, wikidataNames };
