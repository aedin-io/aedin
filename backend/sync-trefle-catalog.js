/**
 * sync-trefle-catalog.js
 *
 * List-only sync of Trefle's full plant catalog (~415K species).
 * Paginates /plants endpoint and inserts new entities with basic data:
 *   scientific_name, common_name, family, genus, image_url, edible, trefle_id
 *
 * Does NOT fetch detail pages (growth, soil, climate). Use sync-trefle-entities.js
 * for that (runs against entities that already have trefle_id but missing detail data).
 *
 * Usage:
 *   node sync-trefle-catalog.js             # sync full catalog
 *   node sync-trefle-catalog.js --limit 5   # limit to 5 pages (1000 plants) for testing
 */
'use strict';

require('dotenv').config();
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const TREFLE_TOKEN = process.env.TREFLE_TOKEN;
const TREFLE_BASE = 'https://trefle.io/api/v1';
const RATE_LIMIT_MS = 500;
const PAGE_SIZE = 200;

if (!TREFLE_TOKEN) {
  console.error('TREFLE_TOKEN not set in .env — cannot sync.');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
  }
  return opts;
}

async function fetchPage(page) {
  const url = `${TREFLE_BASE}/plants?token=${TREFLE_TOKEN}&page=${page}&per_page=${PAGE_SIZE}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trefle ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  const opts = parseArgs();
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Build set of existing scientific names for fast lookup
  const existingRows = await db.all('SELECT scientific_name FROM entities');
  const existingNames = new Set(existingRows.map(r => r.scientific_name.toLowerCase()));
  console.log(`Existing entities: ${existingNames.size}`);

  const insert = await db.prepare(`
    INSERT OR IGNORE INTO entities (
      scientific_name, common_name, family, genus,
      bio_category, primary_role, image_url, edible,
      trefle_id, trefle_synced_at, data_completeness, source_table,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'plantae', 'unclassified', ?, ?, ?, datetime('now'), 'minimal', 'trefle', datetime('now'), datetime('now'))
  `);

  let page = 1;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalPages = null;
  let hasMore = true;

  while (hasMore) {
    if (opts.limit && page > opts.limit) break;

    try {
      const data = await fetchPage(page);
      const plants = data.data || [];

      if (!totalPages && data.meta?.total) {
        totalPages = Math.ceil(data.meta.total / PAGE_SIZE);
        console.log(`Trefle catalog: ${data.meta.total} plants (${totalPages} pages)`);
      }

      if (plants.length === 0) {
        hasMore = false;
        break;
      }

      let pageInserted = 0;
      for (const plant of plants) {
        if (!plant.scientific_name) continue;

        // Skip if already exists
        if (existingNames.has(plant.scientific_name.toLowerCase())) {
          totalSkipped++;
          continue;
        }

        // Skip genus-level entries (single word)
        if (!plant.scientific_name.includes(' ')) {
          totalSkipped++;
          continue;
        }

        const edible = plant.edible ? 1 : (plant.edible === false ? 0 : null);

        try {
          await insert.run(
            plant.scientific_name,
            plant.common_name || null,
            plant.family || null,
            plant.genus || null,
            plant.image_url || null,
            edible,
            plant.id
          );

          existingNames.add(plant.scientific_name.toLowerCase());
          pageInserted++;
          totalInserted++;
        } catch (insertErr) {
          // UNIQUE constraint on trefle_id — another species shares the same Trefle ID
          totalSkipped++;
        }
      }

      if (page % 10 === 0 || page === 1) {
        console.log(`  Page ${page}${totalPages ? '/' + totalPages : ''}: +${pageInserted} new (${totalInserted} total inserted, ${totalSkipped} skipped)`);
      }

      // Check if there's a next page — also respect reported total
      hasMore = !!data.links?.next;
      if (totalPages && page >= totalPages) hasMore = false;
      page++;
    } catch (err) {
      console.warn(`  [error] page ${page}: ${err.message}`);
      if (err.message.includes('429') || err.message.includes('Too Many')) {
        console.log('  Rate limited, waiting 10s...');
        await sleep(10000);
        continue; // retry same page
      }
      page++; // skip page on other errors
    }

    await sleep(RATE_LIMIT_MS);
  }

  await insert.finalize();

  console.log('\n=== Trefle Catalog Sync Summary ===');
  console.log(`Pages fetched:  ${page - 1}`);
  console.log(`New entities:   ${totalInserted}`);
  console.log(`Skipped (exist):${totalSkipped}`);

  const total = await db.get('SELECT COUNT(*) as c FROM entities');
  const plantae = await db.get("SELECT COUNT(*) as c FROM entities WHERE bio_category = 'plantae'");
  console.log(`\nTotal entities: ${total.c}`);
  console.log(`Total plantae:  ${plantae.c}`);

  await db.close();
  console.log('Done.');
}

main().catch(err => { console.error('Trefle catalog sync failed:', err); process.exit(1); });
