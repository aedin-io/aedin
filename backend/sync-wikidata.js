/**
 * sync-wikidata.js
 *
 * Syncs entity data from Wikidata (CC0 licensed, commercially safe).
 * For each entity, fetches via SPARQL:
 *   - IUCN conservation status
 *   - Common name (English)
 *   - EPPO code
 *   - Taxon image
 *   - Host organisms (for parasites/pathogens)
 *   - Diet type (for vertebrates)
 *
 * Wikidata SPARQL endpoint is free, no auth required.
 * Rate limit: be respectful, batch queries where possible.
 *
 * Usage:
 *   node sync-wikidata.js                # sync unsynced entities
 *   node sync-wikidata.js --force        # re-sync all
 *   node sync-wikidata.js --bio invertebrate
 *   node sync-wikidata.js --limit 500
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const BATCH_SIZE = 50;  // SPARQL VALUES batch size
const RATE_LIMIT_MS = 2000; // Wikidata asks for 1 req/sec for bots

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { force: false, bio: '', role: '', limit: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') opts.force = true;
    if (args[i] === '--bio' && args[i + 1]) opts.bio = args[++i];
    if (args[i] === '--role' && args[i + 1]) opts.role = args[++i];
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
  }
  return opts;
}

// Map Wikidata IUCN status entity IDs to codes
const IUCN_MAP = {
  'Q211005': 'LC',   // Least Concern
  'Q719675': 'NT',   // Near Threatened
  'Q278113': 'VU',   // Vulnerable
  'Q11394': 'EN',    // Endangered
  'Q219127': 'CR',   // Critically Endangered
  'Q239509': 'EW',   // Extinct in the Wild
  'Q237350': 'EX',   // Extinct
  'Q3245245': 'DD',  // Data Deficient
  'Q14862269': 'NE', // Not Evaluated
};

async function sparqlQuery(query) {
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AgroEco-Explorer/1.0 (https://github.com/agroeco-io/AgroEco; contact@agroeco.io)' }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SPARQL ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function batchLookup(names) {
  // Escape quotes in names for SPARQL
  const values = names.map(n => `"${n.replace(/"/g, '\\"')}"`).join(' ');

  const query = `
    SELECT ?name ?item ?iucnEntity ?commonName ?eppoCode ?image ?foodLabel WHERE {
      VALUES ?name { ${values} }
      ?item wdt:P225 ?name .
      OPTIONAL { ?item wdt:P141 ?iucnEntity . }
      OPTIONAL { ?item wdt:P1843 ?commonName . FILTER(LANG(?commonName) = "en") }
      OPTIONAL { ?item wdt:P1928 ?eppoCode . }
      OPTIONAL { ?item wdt:P18 ?image . }
      OPTIONAL { ?item wdt:P1034 ?food . ?food rdfs:label ?foodLabel . FILTER(LANG(?foodLabel) = "en") }
    }
  `;

  const data = await sparqlQuery(query);
  const results = {};

  for (const binding of (data.results?.bindings || [])) {
    const name = binding.name?.value;
    if (!name) continue;
    if (!results[name]) results[name] = { foods: [] };
    const r = results[name];

    if (binding.iucnEntity?.value) {
      const qid = binding.iucnEntity.value.split('/').pop();
      if (IUCN_MAP[qid]) r.conservation_status = IUCN_MAP[qid];
    }
    if (binding.commonName?.value && !r.common_name) {
      r.common_name = binding.commonName.value;
    }
    if (binding.eppoCode?.value && !r.eppo_code) {
      r.eppo_code = binding.eppoCode.value;
    }
    if (binding.image?.value && !r.image_url) {
      r.image_url = binding.image.value;
    }
    if (binding.foodLabel?.value) {
      if (!r.foods.includes(binding.foodLabel.value)) r.foods.push(binding.foodLabel.value);
    }
  }

  // Summarize diet from food sources
  for (const r of Object.values(results)) {
    if (r.foods.length && !r.diet_type) {
      r.diet_type = r.foods.slice(0, 5).join(', ');
    }
    delete r.foods;
  }

  return results;
}

async function main() {
  const opts = parseArgs();
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // We use a wikidata_synced column — check if it exists, use iucn_synced_at as proxy
  let where = opts.force ? 'parent_entity_id IS NULL' : 'iucn_synced_at IS NULL AND parent_entity_id IS NULL';
  const params = [];
  if (opts.bio) { where += ' AND bio_category = ?'; params.push(opts.bio); }
  if (opts.role) { where += ' AND primary_role = ?'; params.push(opts.role); }

  let query = `SELECT id, scientific_name, common_name, bio_category, primary_role,
                      conservation_status, eppo_code, image_url, diet_type
               FROM entities WHERE ${where} ORDER BY id`;
  if (opts.limit) query += ` LIMIT ${opts.limit}`;

  const entities = await db.all(query, params);
  console.log(`Found ${entities.length} entities to sync with Wikidata.`);
  if (entities.length === 0) { await db.close(); return; }

  // Build name -> entity map
  const nameMap = {};
  for (const e of entities) {
    nameMap[e.scientific_name] = e;
  }

  let synced = 0, notFound = 0, errors = 0;
  const allNames = entities.map(e => e.scientific_name);

  for (let i = 0; i < allNames.length; i += BATCH_SIZE) {
    const batch = allNames.slice(i, i + BATCH_SIZE);
    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allNames.length / BATCH_SIZE)} (${batch.length} names)...`);

    try {
      const results = await batchLookup(batch);

      for (const name of batch) {
        const e = nameMap[name];
        const wd = results[name];

        if (!wd) {
          notFound++;
          await db.run("UPDATE entities SET iucn_synced_at = datetime('now') WHERE id = ?", e.id);
          continue;
        }

        const updates = { iucn_synced_at: new Date().toISOString() };

        // Only fill gaps — don't overwrite existing data
        if (wd.conservation_status && !e.conservation_status) {
          updates.conservation_status = wd.conservation_status;
        }
        if (wd.eppo_code && !e.eppo_code) {
          updates.eppo_code = wd.eppo_code;
        }
        if (wd.image_url && !e.image_url) {
          updates.image_url = wd.image_url;
        }
        if (wd.diet_type && !e.diet_type) {
          updates.diet_type = wd.diet_type;
        }

        const keys = Object.keys(updates);
        const setClauses = keys.map(k => `${k} = ?`).join(', ') + ", updated_at = datetime('now')";
        await db.run(`UPDATE entities SET ${setClauses} WHERE id = ?`, [...keys.map(k => updates[k]), e.id]);

        synced++;
      }
    } catch (err) {
      errors++;
      console.warn(`  [error] batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err.message}`);
      // Mark batch as synced to avoid retrying bad names
      for (const name of batch) {
        const e = nameMap[name];
        await db.run("UPDATE entities SET iucn_synced_at = datetime('now') WHERE id = ?", e.id);
      }
      await sleep(5000); // back off
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log('\n=== Wikidata Sync Summary ===');
  console.log(`Total:      ${entities.length}`);
  console.log(`Synced:     ${synced}`);
  console.log(`Not found:  ${notFound}`);
  console.log(`Errors:     ${errors} batches`);

  // Stats
  const stats = await db.all("SELECT conservation_status, COUNT(*) AS n FROM entities WHERE conservation_status IS NOT NULL GROUP BY conservation_status ORDER BY n DESC");
  if (stats.length) {
    console.log('\nConservation status breakdown:');
    for (const s of stats) console.log(`  ${s.conservation_status}: ${s.n}`);
  }

  await db.close();
  console.log('Done.');
}

main().catch(err => { console.error('Wikidata sync failed:', err); process.exit(1); });
