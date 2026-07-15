/**
 * sync-gbif.js
 *
 * Syncs entity data from GBIF (Global Biodiversity Information Facility).
 * For each entity, fetches:
 *   - GBIF species key + taxonomy
 *   - Native/invasive range from distribution checklists
 *   - Common name (vernacular)
 *
 * License: Uses GBIF Species API (taxonomic backbone) which is CC0.
 * Does NOT use occurrence search (which has mixed CC0/CC-BY/CC-BY-NC licensing).
 * Commercially safe — no CC-BY-NC data is fetched.
 *
 * GBIF API is free with no auth required, but be respectful of rate limits.
 *
 * Usage:
 *   node sync-gbif.js                # sync unsynced entities
 *   node sync-gbif.js --force        # re-sync all
 *   node sync-gbif.js --bio plantae  # only sync plantae
 *   node sync-gbif.js --role pest    # only sync pests
 *   node sync-gbif.js --limit 500    # cap at 500 entities
 *   node sync-gbif.js --parallel 5   # 5 concurrent (default)
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const { bioCategoryFromLineage } = require('./lib/bio-category-from-lineage');

const DB_PATH = CORPUS_DB;
const GBIF_API = 'https://api.gbif.org/v1';
const INITIAL_RATE_MS = 100;       // ms between batch launches
const MAX_CONCURRENT = 5;          // default parallel
const BACKOFF_MULTIPLIER = 2;      // multiply delay on 429/503
const MAX_RATE_MS = 5000;          // cap backoff

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { force: false, bio: '', role: '', limit: 0, parallel: MAX_CONCURRENT };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') opts.force = true;
    if (args[i] === '--bio' && args[i + 1]) opts.bio = args[++i];
    if (args[i] === '--role' && args[i + 1]) opts.role = args[++i];
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
    if (args[i] === '--parallel' && args[i + 1]) opts.parallel = parseInt(args[++i], 10);
  }
  return opts;
}

// Adaptive rate limiter
let currentRateMs = INITIAL_RATE_MS;

async function fetchJson(url) {
  const res = await fetch(url);

  // Auto-backoff on rate limit or server overload
  if (res.status === 429 || res.status === 503) {
    currentRateMs = Math.min(currentRateMs * BACKOFF_MULTIPLIER, MAX_RATE_MS);
    console.warn(`  [rate-limit] ${res.status} — backing off to ${currentRateMs}ms`);
    return null;
  }

  if (!res.ok) return null;

  // Gradually recover rate if successful
  if (currentRateMs > INITIAL_RATE_MS) {
    currentRateMs = Math.max(INITIAL_RATE_MS, Math.floor(currentRateMs * 0.9));
  }

  return res.json();
}

async function matchSpecies(scientificName) {
  const url = `${GBIF_API}/species/match?name=${encodeURIComponent(scientificName)}&verbose=false`;
  const data = await fetchJson(url);
  if (!data || data.matchType === 'NONE' || !data.usageKey) return null;
  return data;
}

async function getVernacularName(speciesKey) {
  const url = `${GBIF_API}/species/${speciesKey}/vernacularNames?limit=5`;
  const data = await fetchJson(url);
  if (!data || !data.results || data.results.length === 0) return null;
  const en = data.results.find(v => v.language === 'eng' || v.language === 'en');
  return (en || data.results[0]).vernacularName;
}

async function getDistributions(speciesKey) {
  const url = `${GBIF_API}/species/${speciesKey}/distributions?limit=100`;
  const data = await fetchJson(url);
  if (!data || !data.results) return { native: [], invasive: [] };
  const native = [];
  const invasive = [];
  for (const d of data.results) {
    const loc = d.locality || d.country || '';
    if (!loc) continue;
    if (d.establishmentMeans === 'INVASIVE' || d.establishmentMeans === 'INTRODUCED') {
      invasive.push(loc);
    } else if (d.establishmentMeans === 'NATIVE' || !d.establishmentMeans) {
      native.push(loc);
    }
  }
  return {
    native: [...new Set(native)],
    invasive: [...new Set(invasive)]
  };
}

/**
 * Decide how to resolve an entity's GBIF data. A GloBI-sourced key lets us skip
 * the fuzzy /species/match (a 404 on the per-key enrichment fetch falls back).
 */
function resolutionPlan(entity) {
  if (entity.gbif_key != null && entity.lineage_source === 'globi') {
    return { mode: 'use_globi_key', key: entity.gbif_key };
  }
  return { mode: 'match_by_name', key: null };
}

/**
 * Process a single entity — fetch taxonomy, vernacular, distributions.
 * Skips calls for data the entity already has (#1: smart skip).
 */
async function syncOneEntity(db, e) {
  const plan = resolutionPlan(e);

  // use_globi_key: skip /species/match; only refresh vernacular + distributions
  if (plan.mode === 'use_globi_key') {
    const usageKey = plan.key;
    const vn = await getVernacularName(usageKey);
    const dist = await getDistributions(usageKey);
    // Both returned null/empty → treat key as stale, fall through to match_by_name
    if (!vn && !dist.native.length && !dist.invasive.length) {
      // fall through below
    } else {
      const updates = { gbif_synced_at: new Date().toISOString() };
      if (!e.native_regions && !e.invasive_regions) {
        if (dist.native.length) updates.native_regions = JSON.stringify(dist.native);
        if (dist.invasive.length) updates.invasive_regions = JSON.stringify(dist.invasive);
      }
      const keys = Object.keys(updates);
      const setClauses = keys.map(k => `${k} = ?`).join(', ') + ", updated_at = datetime('now')";
      await db.run(`UPDATE entities SET ${setClauses} WHERE id = ?`, [...keys.map(k => updates[k]), e.id]);
      return { status: 'synced', reclassified: false };
    }
  }

  const match = await matchSpecies(e.scientific_name);

  if (!match) {
    await db.run("UPDATE entities SET gbif_synced_at = datetime('now') WHERE id = ?", e.id);
    return { status: 'not_found' };
  }

  const updates = {
    gbif_key: match.usageKey,
    gbif_synced_at: new Date().toISOString(),
    lineage_source: 'gbif_api',
  };

  // Always write taxonomy columns
  if (match.kingdom) updates.kingdom = match.kingdom;
  if (match.phylum) updates.phylum = match.phylum;
  if (match.class) updates.taxon_class = match.class;
  if (match.order) updates.taxon_order = match.order;
  if (!e.family && match.family) updates.family = match.family;
  if (!e.genus && match.genus) updates.genus = match.genus;
  if (match.kingdom) updates.taxonomy_path = [match.kingdom, match.phylum, match.class, match.order, match.family, match.genus].filter(Boolean).join(' | ');

  // Reclassify bio_category from GBIF taxonomy (authoritative)
  let reclassified = false;
  if (match.kingdom) {
    const newBio = bioCategoryFromLineage(match);
    if (newBio !== e.bio_category) {
      updates.bio_category = newBio;
      reclassified = true;
    }
  }

  // #1: Only fetch distributions if entity doesn't already have them
  if (!e.native_regions && !e.invasive_regions) {
    const dist = await getDistributions(match.usageKey);
    if (dist.native.length) updates.native_regions = JSON.stringify(dist.native);
    if (dist.invasive.length) updates.invasive_regions = JSON.stringify(dist.invasive);
  }

  const keys = Object.keys(updates);
  const setClauses = keys.map(k => `${k} = ?`).join(', ') + ", updated_at = datetime('now')";
  await db.run(`UPDATE entities SET ${setClauses} WHERE id = ?`, [...keys.map(k => updates[k]), e.id]);

  return { status: 'synced', reclassified };
}

async function main() {
  const opts = parseArgs();
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  let where = opts.force ? 'parent_entity_id IS NULL' : 'gbif_synced_at IS NULL AND parent_entity_id IS NULL';
  const params = [];
  if (opts.bio) { where += ' AND bio_category = ?'; params.push(opts.bio); }
  if (opts.role) { where += ' AND primary_role = ?'; params.push(opts.role); }

  let query = `SELECT id, scientific_name, common_name, bio_category, primary_role,
                      family, genus, native_regions, invasive_regions,
                      gbif_key, lineage_source FROM entities WHERE ${where} ORDER BY id`;
  if (opts.limit) { query += ` LIMIT ${opts.limit}`; }

  const entities = await db.all(query, params);
  const concurrency = Math.max(1, Math.min(10, opts.parallel));
  console.log(`Found ${entities.length} entities to sync with GBIF.`);
  console.log(`Concurrency: ${concurrency} | Initial rate: ${INITIAL_RATE_MS}ms`);
  if (entities.length === 0) { await db.close(); return; }

  let synced = 0, notFound = 0, errors = 0, reclassified = 0;
  const startTime = Date.now();

  // Process in batches of `concurrency`
  for (let i = 0; i < entities.length; i += concurrency) {
    const batch = entities.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map(e => syncOneEntity(db, e).catch(err => {
        if (errors <= 5) console.warn(`  [error] ${e.scientific_name}: ${err.message}`);
        return { status: 'error' };
      }))
    );

    for (const r of results) {
      const val = r.status === 'fulfilled' ? r.value : { status: 'error' };
      if (val.status === 'synced') {
        synced++;
        if (val.reclassified) reclassified++;
      } else if (val.status === 'not_found') {
        notFound++;
      } else {
        errors++;
      }
    }

    // Progress reporting
    const done = Math.min(i + concurrency, entities.length);
    if (done % 200 < concurrency || done === entities.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (done / (Date.now() - startTime) * 1000).toFixed(1);
      console.log(`  ${done}/${entities.length} (synced: ${synced}, not found: ${notFound}, errors: ${errors}) [${elapsed}s, ${rate}/s, delay: ${currentRateMs}ms]`);
    }

    // Adaptive delay between batches
    await sleep(currentRateMs);
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n=== GBIF Sync Summary ===');
  console.log(`Total:        ${entities.length}`);
  console.log(`Synced:       ${synced}`);
  console.log(`Not found:    ${notFound}`);
  console.log(`Reclassified: ${reclassified}`);
  console.log(`Errors:       ${errors}`);
  console.log(`Time:         ${totalTime} minutes`);

  const bioStats = await db.all('SELECT bio_category, COUNT(*) as n FROM entities GROUP BY bio_category ORDER BY n DESC');
  console.log('\nBio category breakdown:');
  for (const s of bioStats) console.log(`  ${s.bio_category}: ${s.n}`);

  await db.close();
  console.log('Done.');
}

if (require.main === module) {
  main().catch(err => { console.error('GBIF sync failed:', err); process.exit(1); });
}

module.exports = { resolutionPlan };
