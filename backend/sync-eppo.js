/**
 * ⚠️  WARNING: EPPO data is NON-COMMERCIAL use only.
 * Do NOT use this script if you intend to profit from the data.
 * For commercial use, use sync-wikidata.js (CC0) and sync-gbif.js (CC0) instead.
 *
 * sync-eppo.js
 *
 * Syncs entity data from EPPO Global Database.
 * For pest/pathogen/invertebrate entities, fetches:
 *   - EPPO code
 *   - Host plants
 *   - Distribution (country-level presence/absence)
 *   - Quarantine/regulatory status
 *
 * EPPO REST API: https://data.eppo.int/api/rest/1.0
 * Requires free API token from https://data.eppo.int
 *
 * Usage:
 *   node sync-eppo.js                # sync unsynced pest/pathogen entities
 *   node sync-eppo.js --force        # re-sync all
 *   node sync-eppo.js --limit 200    # cap at 200
 */
'use strict';

require('dotenv').config();
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const EPPO_TOKEN = process.env.EPPO_TOKEN;
const EPPO_API = 'https://data.eppo.int/api/rest/1.0';
const RATE_LIMIT_MS = 500;

if (!EPPO_TOKEN) {
  console.error('EPPO_TOKEN not set in .env');
  console.error('Get a free token at https://data.eppo.int → Register → API access');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { force: false, limit: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') opts.force = true;
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
  }
  return opts;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${EPPO_TOKEN}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function searchEppo(scientificName) {
  const url = `${EPPO_API}/tools/search/${encodeURIComponent(scientificName)}?authtoken=${EPPO_TOKEN}`;
  const data = await fetchJson(url);
  if (!data || data.length === 0) return null;
  // Find exact or best match
  const exact = data.find(d => d.fullname?.toLowerCase() === scientificName.toLowerCase());
  return exact || data[0];
}

async function getHosts(eppoCode) {
  const url = `${EPPO_API}/taxon/${eppoCode}/hosts?authtoken=${EPPO_TOKEN}`;
  const data = await fetchJson(url);
  if (!data || data.length === 0) return [];
  return data.map(h => h.fullname || h.codename).filter(Boolean);
}

async function getDistribution(eppoCode) {
  const url = `${EPPO_API}/taxon/${eppoCode}/distribution?authtoken=${EPPO_TOKEN}`;
  const data = await fetchJson(url);
  if (!data || data.length === 0) return [];
  return data.map(d => ({
    country: d.country || d.continent,
    status: d.status, // Present, Absent, Transient, etc.
  })).filter(d => d.country);
}

async function getCategorization(eppoCode) {
  const url = `${EPPO_API}/taxon/${eppoCode}/categorization?authtoken=${EPPO_TOKEN}`;
  const data = await fetchJson(url);
  if (!data || data.length === 0) return null;
  // Look for quarantine/regulated status
  const statuses = data.map(c => `${c.nomcontinent || c.country || 'Global'}: ${c.liste || c.status || 'listed'}`);
  return statuses.join('; ');
}

async function main() {
  const opts = parseArgs();
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Target non-plant entities (pests, pathogens, fungi, microbes, invertebrates)
  let where = opts.force ? "bio_category != 'plantae'" : "bio_category != 'plantae' AND eppo_synced_at IS NULL";
  let query = `SELECT id, scientific_name, bio_category, primary_role
               FROM entities WHERE ${where} ORDER BY id`;
  if (opts.limit) query += ` LIMIT ${opts.limit}`;

  const entities = await db.all(query);
  console.log(`Found ${entities.length} entities to sync with EPPO.`);
  if (entities.length === 0) { await db.close(); return; }

  let synced = 0, notFound = 0, errors = 0;

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (i > 0 && i % 50 === 0) {
      console.log(`  ${i}/${entities.length} (synced: ${synced}, not found: ${notFound}, errors: ${errors})`);
    }

    try {
      const match = await searchEppo(e.scientific_name);
      await sleep(RATE_LIMIT_MS);

      if (!match || !match.eppocode) {
        notFound++;
        await db.run("UPDATE entities SET eppo_synced_at = datetime('now') WHERE id = ?", e.id);
        continue;
      }

      const eppoCode = match.eppocode;
      const updates = {
        eppo_code: eppoCode,
        eppo_synced_at: new Date().toISOString(),
      };

      // Hosts
      const hosts = await getHosts(eppoCode);
      await sleep(RATE_LIMIT_MS);
      if (hosts.length) updates.host_range = JSON.stringify(hosts);

      // Distribution
      const dist = await getDistribution(eppoCode);
      await sleep(RATE_LIMIT_MS);
      if (dist.length) {
        const present = dist.filter(d => d.status === 'Present').map(d => d.country);
        if (present.length) updates.native_regions = JSON.stringify(present);
      }

      // Categorization / regulatory status
      const categ = await getCategorization(eppoCode);
      await sleep(RATE_LIMIT_MS);
      if (categ) updates.conservation_status = categ; // repurpose for regulatory status

      const keys = Object.keys(updates);
      const setClauses = keys.map(k => `${k} = ?`).join(', ') + ", updated_at = datetime('now')";
      await db.run(`UPDATE entities SET ${setClauses} WHERE id = ?`, [...keys.map(k => updates[k]), e.id]);

      synced++;
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  [error] ${e.scientific_name}: ${err.message}`);
      await sleep(1000);
    }
  }

  console.log('\n=== EPPO Sync Summary ===');
  console.log(`Total:      ${entities.length}`);
  console.log(`Synced:     ${synced}`);
  console.log(`Not found:  ${notFound}`);
  console.log(`Errors:     ${errors}`);

  await db.close();
  console.log('Done.');
}

main().catch(err => { console.error('EPPO sync failed:', err); process.exit(1); });
