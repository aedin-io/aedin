/**
 * sync-grin-varieties.js
 *
 * Scrapes crop variety/cultivar names from the USDA GRIN-Global search page.
 * Creates child entities under parent crop species.
 *
 * GRIN-Global has no REST API — this scrapes the HTML search results at:
 *   https://npgsweb.ars-grin.gov/gringlobal/search?q=<species>&rows=2000
 *
 * Public domain (US government data). Be respectful of rate limits.
 *
 * Usage:
 *   node sync-grin-varieties.js                          # sync all plantae
 *   node sync-grin-varieties.js --limit 5                # limit to 5 species
 *   node sync-grin-varieties.js --crop "Solanum lycopersicum"
 *   node sync-grin-varieties.js --force                  # re-sync already synced
 *   node sync-grin-varieties.js --dry-run                # preview without writing
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const GRIN_SEARCH = 'https://npgsweb.ars-grin.gov/gringlobal/search';
const RATE_LIMIT_MS = 2000; // Be respectful — server-rendered pages are heavier
const MAX_ROWS = 2000;      // Cap per species

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 0, crop: '', force: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
    if (args[i] === '--crop' && args[i + 1]) opts.crop = args[++i];
    if (args[i] === '--force') opts.force = true;
    if (args[i] === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

/**
 * Parse GRIN HTML table rows into structured variety data.
 * Returns array of { grin_accession, plant_name, origin, improvement_level, narrative }
 */
function parseGrinHtml(html) {
  const rowPattern = /<tr><td>\d+<\/td>(.*?)<\/tr>/gs;
  const rows = [];
  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const cellPattern = /<td[^>]*>(.*?)<\/td>/gs;
    const cells = []; let cm;
    while ((cm = cellPattern.exec(match[1])) !== null) cells.push(cm[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 5) continue;
    const plant_name = cells[1];
    if (!plant_name) continue;
    rows.push({ grin_accession: cells[0] || '', plant_name, origin: cells[3] || '', improvement_level: cells[14] || '', narrative: cells[15] || '' });
  }
  return rows;
}

/**
 * Scrape GRIN search results for a species.
 * Returns array of { grin_accession, plant_name, origin, improvement_level, narrative }
 */
async function scrapeGrinVarieties(scientificName) {
  const url = `${GRIN_SEARCH}?q=${encodeURIComponent(scientificName)}&rows=${MAX_ROWS}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AgroEco-Explorer/1.0 (variety-sync; contact: github.com/agroeco-io/AgroEco)' }
  });

  if (!res.ok) return null;
  const html = await res.text();
  if (!html || html.length < 500) return null;

  return parseGrinHtml(html);
}

async function main() {
  const opts = parseArgs();
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Ensure grin_synced_at column exists
  const cols = await db.all('PRAGMA table_info(entities)');
  if (!cols.some(c => c.name === 'grin_synced_at')) {
    await db.run('ALTER TABLE entities ADD COLUMN grin_synced_at TEXT');
  }

  let where = "primary_role = 'crop' AND parent_entity_id IS NULL";
  if (!opts.force) where += " AND grin_synced_at IS NULL";
  if (opts.crop) where += ' AND scientific_name = ?';

  let query = `SELECT id, scientific_name, common_name FROM entities WHERE ${where} ORDER BY scientific_name`;
  if (opts.limit) query += ` LIMIT ${opts.limit}`;

  const params = opts.crop ? [opts.crop] : [];
  const crops = await db.all(query, params);
  console.log(`Found ${crops.length} species to sync with GRIN.`);
  console.log(`Mode: ${opts.dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (crops.length === 0) { await db.close(); return; }

  let totalVarieties = 0, cropsProcessed = 0, cropsNotFound = 0, errors = 0;

  for (let i = 0; i < crops.length; i++) {
    const crop = crops[i];
    if (i > 0 && i % 10 === 0) {
      console.log(`  ${i}/${crops.length} crops (varieties: ${totalVarieties}, not found: ${cropsNotFound})`);
    }

    try {
      const varieties = await scrapeGrinVarieties(crop.scientific_name);
      await sleep(RATE_LIMIT_MS);

      if (!varieties || varieties.length === 0) {
        cropsNotFound++;
        if (!opts.dryRun) {
          await db.run("UPDATE entities SET grin_synced_at = datetime('now') WHERE id = ?", crop.id);
        }
        continue;
      }

      let cropVarieties = 0;
      for (const v of varieties) {
        if (!v.grin_accession) continue;

        if (!opts.dryRun) {
          try {
            await db.run(
              `INSERT INTO grin_varieties (grin_accession, parent_entity_id, plant_name, origin, improvement_level, narrative, scraped_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(grin_accession) DO UPDATE SET
                 plant_name=excluded.plant_name, origin=excluded.origin,
                 improvement_level=excluded.improvement_level, narrative=excluded.narrative, scraped_at=datetime('now')`,
              [v.grin_accession, crop.id, v.plant_name, v.origin, v.improvement_level, v.narrative]
            );
          } catch (insertErr) {
            // Handle error — skip row
            continue;
          }
        }

        cropVarieties++;
        totalVarieties++;
      }

      if (!opts.dryRun) {
        await db.run("UPDATE entities SET grin_synced_at = datetime('now') WHERE id = ?", crop.id);
      }
      cropsProcessed++;

      if (cropVarieties > 0) {
        console.log(`  ${crop.scientific_name}: +${cropVarieties} varieties (${varieties.length} accessions scraped)`);
      }
    } catch (err) {
      errors++;
      if (errors <= 5) console.warn(`  [error] ${crop.scientific_name}: ${err.message}`);
      await sleep(3000);
    }
  }

  console.log('\n=== GRIN Variety Sync Summary ===');
  console.log(`Crops processed:  ${cropsProcessed}`);
  console.log(`Crops not found:  ${cropsNotFound}`);
  console.log(`Varieties added:  ${totalVarieties}`);
  console.log(`Errors:           ${errors}`);

  const total = await db.get('SELECT COUNT(*) as c FROM entities WHERE parent_entity_id IS NOT NULL');
  console.log(`\nTotal variety entities: ${total.c}`);

  await db.close();
  console.log('Done.');
}

module.exports = { parseGrinHtml };

if (require.main === module) main().catch(err => { console.error('GRIN sync failed:', err); process.exit(1); });
