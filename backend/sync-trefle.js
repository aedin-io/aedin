/**
 * sync-trefle.js
 *
 * Pulls edible and vegetable species from the Trefle API and populates
 * the crops table with botanical data. Designed to run once as an initial
 * seed, then periodically to pick up corrections in Trefle's dataset.
 *
 * What it does:
 *   1. Paginates through Trefle /api/v1/species filtered to edible plants
 *   2. For each species, fetches the full detail record (growth, soil, climate)
 *   3. Upserts into the crops table, preserving any AgroEco-specific fields
 *      (crop_type, climate_zone) that were set manually
 *   4. Stores native/introduced zone arrays as JSON
 *   5. Logs a coverage report: how many records have each key field
 *
 * Usage:
 *   TREFLE_TOKEN=your_token node sync-trefle.js
 *
 *   Optional env vars:
 *   TREFLE_DELAY_MS  — ms between detail requests (default: 300, be polite)
 *   TREFLE_MAX_PAGES — stop after N pages for testing (default: unlimited)
 *   TREFLE_DRY_RUN   — print records without writing to DB (default: false)
 *
 * Notes on Trefle coverage:
 *   - Trefle skews temperate. Pacific/tropical crops (taro, breadfruit, ulu)
 *     may have incomplete growth/soil data. The data_completeness field tracks this.
 *   - If a crop already exists (matched by scientific_name), Trefle fields are
 *     updated but AgroEco-specific fields (crop_type, climate_zone) are preserved.
 *   - After this sync, run the LLM extraction pipeline to fill gaps for
 *     Pacific crops that Trefle doesn't cover well.
 */

'use strict';

const sqlite3  = require('sqlite3').verbose();
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const TREFLE_TOKEN  = process.env.TREFLE_TOKEN;
const BASE_URL      = 'https://trefle.io/api/v1';
const DELAY_MS      = parseInt(process.env.TREFLE_DELAY_MS  || '300', 10);
const MAX_PAGES     = parseInt(process.env.TREFLE_MAX_PAGES || '5',   10); // 0 = unlimited
const DRY_RUN       = process.env.TREFLE_DRY_RUN === 'true';
const DB_PATH       = CORPUS_DB;

if (!TREFLE_TOKEN) {
  console.error('❌  TREFLE_TOKEN env var is required. Get one at https://trefle.io/profile');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function trefleGet(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}token=${TREFLE_TOKEN}`);
  if (res.status === 429) {
    console.warn('  ⚠️  rate limited — waiting 5s');
    await sleep(5000);
    return trefleGet(url);
  }
  if (!res.ok) throw new Error(`Trefle ${res.status} on ${url}`);
  return res.json();
}

/** Normalise a Trefle species detail record into a flat crops row */
function normalise(s) {
  const g  = s.main_species?.growth      || s.growth      || {};
  const sp = s.main_species?.specifications || s.specifications || {};
  const ms = s.main_species || s;

  // Distribution zones
  const dist   = ms.distributions || {};
  const native = (dist.native     || []).map(z => z.name || z.tdwg_code).filter(Boolean);
  const intro  = (dist.introduced || []).map(z => z.name || z.tdwg_code).filter(Boolean);

  // Completeness heuristic: consider "full" if we have pH + root depth + nitrogen_fixation
  const hasCoreGrowth = g.ph_minimum != null && g.minimum_root_depth?.cm != null;
  const hasNitrogen   = sp.nitrogen_fixation != null;
  const completeness  = (hasCoreGrowth && hasNitrogen) ? 'full' : hasCoreGrowth ? 'partial' : 'minimal';

  return {
    trefle_id:              ms.id,
    scientific_name:        ms.scientific_name,
    common_name:            ms.common_name    || null,
    slug:                   ms.slug           || null,
    family:                 ms.family         || null,
    family_common_name:     ms.family_common_name || null,
    genus:                  ms.genus          || null,
    synonyms:               JSON.stringify((ms.synonyms || []).map(sy => sy.name).filter(Boolean)),

    // Taxonomy
    duration:               JSON.stringify(ms.duration   || []),
    edible_part:            JSON.stringify(ms.edible_part || []),
    edible:                 ms.edible    ? 1 : 0,
    vegetable:              ms.vegetable ? 1 : 0,

    // Growth
    days_to_harvest:        g.days_to_harvest         ?? null,
    growth_rate:            sp.growth_rate            || null,
    growth_habit:           sp.growth_habit           || null,
    growth_form:            sp.growth_form            || null,
    ligneous_type:          sp.ligneous_type          || null,
    shape_and_orientation:  sp.shape_and_orientation  || null,
    average_height_cm:      sp.average_height?.cm     ?? null,
    maximum_height_cm:      sp.maximum_height?.cm     ?? null,
    growth_months:          JSON.stringify(g.growth_months || []),
    bloom_months:           JSON.stringify(g.bloom_months  || []),
    fruit_months:           JSON.stringify(g.fruit_months  || []),
    row_spacing_cm:         g.row_spacing?.cm          ?? null,
    spread_cm:              g.spread?.cm               ?? null,
    min_root_depth_cm:      g.minimum_root_depth?.cm   ?? null,

    // Soil (consolidated names)
    optimal_ph_min:           g.ph_minimum               ?? null,
    optimal_ph_max:           g.ph_maximum               ?? null,
    optimal_soil_texture:     g.soil_texture             ?? null,
    optimal_soil_moisture:    g.soil_humidity            ?? null,
    soil_nutriments:          g.soil_nutriments          ?? null,
    soil_salinity:            g.soil_salinity            ?? null,
    optimal_light:            g.light                    ?? null,
    optimal_humidity_min:     g.atmospheric_humidity != null ? g.atmospheric_humidity * 10 : null,

    // Climate (consolidated names)
    optimal_temp_min:         g.minimum_temperature?.deg_c ?? null,
    optimal_temp_max:         g.maximum_temperature?.deg_c ?? null,
    optimal_precip_min:       g.minimum_precipitation?.mm  ?? null,
    optimal_precip_max:       g.maximum_precipitation?.mm  ?? null,

    // Key polyculture signals
    nitrogen_fixation:      sp.nitrogen_fixation || null,
    toxicity:               sp.toxicity          || null,

    // Distribution
    native_zones:           JSON.stringify(native),
    introduced_zones:       JSON.stringify(intro),

    // Image
    image_url:              ms.image_url || null,

    // Sync metadata
    trefle_synced_at:       new Date().toISOString(),
    data_completeness:      completeness,
  };
}

// ── Upsert ────────────────────────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO crops (
    trefle_id, scientific_name, common_name, slug,
    family, family_common_name, genus, synonyms,
    duration, edible_part, edible, vegetable,
    days_to_harvest, growth_rate, growth_habit, growth_form,
    ligneous_type, shape_and_orientation,
    average_height_cm, maximum_height_cm,
    growth_months, bloom_months, fruit_months,
    row_spacing_cm, spread_cm, min_root_depth_cm,
    optimal_ph_min, optimal_ph_max,
    optimal_soil_texture, optimal_soil_moisture, soil_nutriments, soil_salinity,
    optimal_light, optimal_humidity_min,
    optimal_temp_min, optimal_temp_max,
    optimal_precip_min, optimal_precip_max,
    nitrogen_fixation, toxicity,
    native_zones, introduced_zones,
    image_url, trefle_synced_at, data_completeness
  ) VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?,
    ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?,
    ?, ?,
    ?, ?,
    ?, ?,
    ?, ?,
    ?, ?,
    ?, ?, ?
  )
  ON CONFLICT(scientific_name) DO UPDATE SET
    trefle_id             = excluded.trefle_id,
    common_name           = excluded.common_name,
    slug                  = excluded.slug,
    family                = excluded.family,
    family_common_name    = excluded.family_common_name,
    genus                 = excluded.genus,
    synonyms              = excluded.synonyms,
    duration              = excluded.duration,
    edible_part           = excluded.edible_part,
    edible                = excluded.edible,
    vegetable             = excluded.vegetable,
    days_to_harvest       = excluded.days_to_harvest,
    growth_rate           = excluded.growth_rate,
    growth_habit          = excluded.growth_habit,
    growth_form           = excluded.growth_form,
    ligneous_type         = excluded.ligneous_type,
    shape_and_orientation = excluded.shape_and_orientation,
    average_height_cm     = excluded.average_height_cm,
    maximum_height_cm     = excluded.maximum_height_cm,
    growth_months         = excluded.growth_months,
    bloom_months          = excluded.bloom_months,
    fruit_months          = excluded.fruit_months,
    row_spacing_cm        = excluded.row_spacing_cm,
    spread_cm             = excluded.spread_cm,
    min_root_depth_cm     = excluded.min_root_depth_cm,
    optimal_ph_min        = excluded.optimal_ph_min,
    optimal_ph_max        = excluded.optimal_ph_max,
    optimal_soil_texture  = excluded.optimal_soil_texture,
    optimal_soil_moisture = excluded.optimal_soil_moisture,
    soil_nutriments       = excluded.soil_nutriments,
    soil_salinity         = excluded.soil_salinity,
    optimal_light         = excluded.optimal_light,
    optimal_humidity_min  = excluded.optimal_humidity_min,
    optimal_temp_min      = excluded.optimal_temp_min,
    optimal_temp_max      = excluded.optimal_temp_max,
    optimal_precip_min    = excluded.optimal_precip_min,
    optimal_precip_max    = excluded.optimal_precip_max,
    nitrogen_fixation     = excluded.nitrogen_fixation,
    toxicity              = excluded.toxicity,
    native_zones          = excluded.native_zones,
    introduced_zones      = excluded.introduced_zones,
    image_url             = excluded.image_url,
    trefle_synced_at      = excluded.trefle_synced_at,
    data_completeness     = excluded.data_completeness,
    updated_at            = datetime('now')
    -- NOTE: crop_type and climate_zone are intentionally NOT updated here.
    -- Those are AgroEco-specific fields set manually or by the LLM pipeline.
    -- A Trefle re-sync must never overwrite our own classifications.
`;

// ── Coverage report ───────────────────────────────────────────────────────────

async function printCoverageReport(db) {
  const total = (await db.get('SELECT COUNT(*) as n FROM crops')).n;
  if (!total) return;

  const fields = [
    'optimal_ph_min', 'optimal_ph_max', 'min_root_depth_cm', 'nitrogen_fixation',
    'days_to_harvest', 'growth_rate', 'optimal_temp_min', 'optimal_soil_texture',
    'native_zones', 'crop_type', 'climate_zone',
  ];

  console.log(`\n📊 Coverage report (${total} crops total):`);
  for (const f of fields) {
    const { n } = await db.get(
      `SELECT COUNT(*) as n FROM crops WHERE ${f} IS NOT NULL AND ${f} != '[]' AND ${f} != ''`
    );
    const pct = Math.round((n / total) * 100);
    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
    console.log(`  ${f.padEnd(25)} ${bar} ${pct}% (${n}/${total})`);
  }

  // Completeness breakdown
  const rows = await db.all(
    `SELECT data_completeness, COUNT(*) as n FROM crops GROUP BY data_completeness`
  );
  console.log('\n  data_completeness breakdown:');
  rows.forEach(r => console.log(`    ${r.data_completeness}: ${r.n}`));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌿 AgroEco Trefle sync starting...');
  console.log(`   DRY_RUN: ${DRY_RUN}`);
  console.log(`   DELAY_MS: ${DELAY_MS}`);
  console.log(`   MAX_PAGES: ${MAX_PAGES || 'unlimited'}\n`);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA journal_mode = WAL');

  let page       = 1;
  let nextUrl    = `${BASE_URL}/species?filter[edible]=true&order[scientific_name]=asc&page_size=20`;
  let inserted   = 0;
  let updated    = 0;
  let skipped    = 0;
  let detailFail = 0;

  while (nextUrl) {
    if (MAX_PAGES && page > MAX_PAGES) {
      console.log(`\n⏹  MAX_PAGES (${MAX_PAGES}) reached — stopping.`);
      break;
    }

    console.log(`📄 Page ${page}: ${nextUrl}`);
    let listData;
    try {
      listData = await trefleGet(nextUrl);
    } catch (err) {
      console.error(`  ❌ list fetch failed: ${err.message}`);
      break;
    }

    const species = listData.data || [];
    console.log(`  ${species.length} species on this page`);

    for (const s of species) {
      // Fetch full detail record to get growth/soil fields
      let detail;
      try {
        const detailData = await trefleGet(`${BASE_URL}/species/${s.id}`);
        detail = detailData.data;
        await sleep(DELAY_MS);
      } catch (err) {
        console.warn(`  ⚠️  detail fetch failed for ${s.scientific_name}: ${err.message}`);
        detailFail++;
        continue;
      }

      const row = normalise(detail);

      if (DRY_RUN) {
        console.log(`  [DRY] ${row.scientific_name} — completeness: ${row.data_completeness}`);
        inserted++;
        continue;
      }

      try {
        const existing = await db.get(
          'SELECT id FROM crops WHERE scientific_name = ?',
          row.scientific_name
        );
        await db.run(UPSERT_SQL, [
          row.trefle_id, row.scientific_name, row.common_name, row.slug,
          row.family, row.family_common_name, row.genus, row.synonyms,
          row.duration, row.edible_part, row.edible, row.vegetable,
          row.days_to_harvest, row.growth_rate, row.growth_habit, row.growth_form,
          row.ligneous_type, row.shape_and_orientation,
          row.average_height_cm, row.maximum_height_cm,
          row.growth_months, row.bloom_months, row.fruit_months,
          row.row_spacing_cm, row.spread_cm, row.min_root_depth_cm,
          row.optimal_ph_min, row.optimal_ph_max,
          row.optimal_soil_texture, row.optimal_soil_moisture, row.soil_nutriments, row.soil_salinity,
          row.optimal_light, row.optimal_humidity_min,
          row.optimal_temp_min, row.optimal_temp_max,
          row.optimal_precip_min, row.optimal_precip_max,
          row.nitrogen_fixation, row.toxicity,
          row.native_zones, row.introduced_zones,
          row.image_url, row.trefle_synced_at, row.data_completeness,
        ]);
        if (existing) updated++; else inserted++;
      } catch (err) {
        console.error(`  ❌ upsert failed for ${row.scientific_name}: ${err.message}`);
        skipped++;
      }
    }

    // Pagination
    nextUrl = listData.links?.next
      ? `https://trefle.io${listData.links.next}`
      : null;
    page++;

    // Brief pause between pages
    if (nextUrl) await sleep(DELAY_MS);
  }

  console.log('\n─────────────────────────────────');
  console.log(`✅ Sync complete`);
  console.log(`   Inserted : ${inserted}`);
  console.log(`   Updated  : ${updated}`);
  console.log(`   Skipped  : ${skipped}`);
  console.log(`   Detail ✗ : ${detailFail}`);

  if (!DRY_RUN) await printCoverageReport(db);

  await db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
