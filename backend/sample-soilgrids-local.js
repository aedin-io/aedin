#!/usr/bin/env node
'use strict';

/**
 * sample-soilgrids-local.js
 *
 * Samples the local SoilGrids COGs (downloaded by download-soilgrids-cogs.sh)
 * and populates the soil_* columns of climate_grid. Much faster than the
 * rest.isric.org REST API — no network calls, no rate limits.
 *
 * Prerequisite:
 *   bash download-soilgrids-cogs.sh
 *
 * Usage:
 *   node sample-soilgrids-local.js
 *   node sample-soilgrids-local.js --all          # re-sample every row (overwrite)
 *   node sample-soilgrids-local.js --limit=500    # smoke test
 *
 * License: SoilGrids is ISRIC CC-BY 4.0. Attribute in any downstream product.
 *
 * Unit conversions (same as backfill-climate.js fetchSoilData):
 *   phh2o  / 10  → pH
 *   clay   / 10  → %
 *   sand   / 10  → %
 *   silt   / 10  → %
 *   soc    / 10  → g/kg
 *   cec    / 10  → cmol(c)/kg
 *   nitrogen / 100 → g/kg
 *   bdod   / 100 → kg/dm³
 *   cfvo   / 10  → vol %
 *   wv0033 / 10  → field capacity vol %
 *   wv1500 / 10  → wilting point vol %
 *   soil_available_water = field capacity − wilting point
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { fromFile } = require('geotiff');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const SOIL_DIR = path.join(__dirname, 'data', 'soilgrids');

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const OFFSET = parseInt(process.argv.find(a => a.startsWith('--offset='))?.split('=')[1] || '0', 10);
const FORCE = process.argv.includes('--all') || process.argv.includes('--force');

const PROPERTIES = ['phh2o','clay','sand','silt','soc','cec','nitrogen','bdod','cfvo','wv0033','wv1500'];
const DEPTHS = ['0-5cm','5-15cm','15-30cm'];

const D_FACTOR = {
  phh2o: 10, clay: 10, sand: 10, silt: 10, soc: 10, cec: 10,
  nitrogen: 100, bdod: 100, cfvo: 10, wv0033: 10, wv1500: 10,
};

// ── Raster loading ──────────────────────────────────────────────────────────

async function loadRaster(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const tiff = await fromFile(filepath);
  const image = await tiff.getImage();
  const rasterData = await image.readRasters();
  const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
  return {
    data: rasterData[0],
    bbox,
    width: image.getWidth(),
    height: image.getHeight(),
    pixelWidth: (bbox[2] - bbox[0]) / image.getWidth(),
    pixelHeight: (bbox[3] - bbox[1]) / image.getHeight(),
    nodata: image.getGDALNoData(),
  };
}

function sampleRaster(raster, lat, lon) {
  if (!raster) return null;
  if (lon < raster.bbox[0] || lon > raster.bbox[2] ||
      lat < raster.bbox[1] || lat > raster.bbox[3]) return null;
  const col = Math.floor((lon - raster.bbox[0]) / raster.pixelWidth);
  const row = Math.floor((raster.bbox[3] - lat) / raster.pixelHeight);
  if (col < 0 || col >= raster.width || row < 0 || row >= raster.height) return null;
  const val = raster.data[row * raster.width + col];
  if (val === raster.nodata || val === -9999 || val < -1e+30 || Number.isNaN(val)) return null;
  return val;
}

// ── Main ────────────────────────────────────────────────────────────────────

const round1 = v => v == null ? null : Math.round(v * 10) / 10;
const round2 = v => v == null ? null : Math.round(v * 100) / 100;

async function loadAllRasters() {
  // rasters[prop][depth] = raster (single global file per prop/depth)
  const rasters = {};
  let loaded = 0, missing = 0;
  for (const prop of PROPERTIES) {
    rasters[prop] = {};
    for (const depth of DEPTHS) {
      const file = path.join(SOIL_DIR, `${prop}_${depth}.tif`);
      const r = await loadRaster(file);
      if (r) {
        rasters[prop][depth] = r;
        loaded++;
      } else {
        missing++;
      }
    }
  }
  console.log(`  Loaded ${loaded}/${loaded + missing} rasters from ${SOIL_DIR}`);
  return rasters;
}

/**
 * Sample all 11 properties × 3 depths at (lat, lon), average across depths,
 * and return a soil-columns object ready for UPDATE (or null if no data).
 */
function sampleSoilAt(rasters, lat, lon) {
  const averaged = {};

  for (const prop of PROPERTIES) {
    const values = [];
    for (const depth of DEPTHS) {
      const r = rasters[prop]?.[depth];
      const v = sampleRaster(r, lat, lon);
      if (v != null) values.push(v);
    }
    averaged[prop] = values.length > 0
      ? (values.reduce((a, b) => a + b, 0) / values.length) / D_FACTOR[prop]
      : null;
  }

  // Reject if everything is null (ocean/no-data cell).
  const core = ['phh2o','clay','sand','silt','soc','cec','nitrogen','bdod'];
  if (core.every(p => averaged[p] == null)) return null;

  const fc = averaged.wv0033;
  const wp = averaged.wv1500;
  const paw = (fc != null && wp != null) ? round1(fc - wp) : null;

  return {
    soil_ph_surface: round1(averaged.phh2o),
    soil_clay_pct: round1(averaged.clay),
    soil_sand_pct: round1(averaged.sand),
    soil_silt_pct: round1(averaged.silt),
    soil_organic_carbon: round1(averaged.soc),
    soil_cec: round1(averaged.cec),
    soil_nitrogen: round2(averaged.nitrogen),
    soil_bulk_density: round2(averaged.bdod),
    soil_coarse_fragments_pct: round1(averaged.cfvo),
    soil_water_field_capacity: round1(fc),
    soil_water_wilting_point: round1(wp),
    soil_available_water: paw,
  };
}

const UPDATE_SQL = `
  UPDATE climate_grid SET
    soil_ph_surface = ?,
    soil_clay_pct = ?,
    soil_sand_pct = ?,
    soil_silt_pct = ?,
    soil_organic_carbon = ?,
    soil_cec = ?,
    soil_nitrogen = ?,
    soil_bulk_density = ?,
    soil_coarse_fragments_pct = ?,
    soil_water_field_capacity = ?,
    soil_water_wilting_point = ?,
    soil_available_water = ?
  WHERE id = ?
`;

async function main() {
  console.log('sample-soilgrids-local.js');
  console.log(`  SoilGrids dir: ${SOIL_DIR}`);

  if (!fs.existsSync(SOIL_DIR)) {
    console.error(`\nERROR: ${SOIL_DIR} does not exist.`);
    console.error('Run download-soilgrids-cogs.sh first:');
    console.error('  bash download-soilgrids-cogs.sh');
    process.exit(1);
  }

  console.log('Loading rasters...');
  const rasters = await loadAllRasters();

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA busy_timeout = 30000');

  const where = FORCE
    ? 'WHERE 1=1'
    : `WHERE (
         soil_ph_surface IS NULL OR
         soil_silt_pct IS NULL OR
         soil_cec IS NULL OR
         soil_nitrogen IS NULL OR
         soil_bulk_density IS NULL OR
         soil_water_field_capacity IS NULL
       )`;

  let query = `SELECT id, lat, lon FROM climate_grid ${where} ORDER BY id`;
  if (LIMIT > 0) query += ` LIMIT ${LIMIT}`;
  if (OFFSET > 0) query += ` OFFSET ${OFFSET}`;

  const rows = await db.all(query);
  console.log(`\nSampling ${rows.length} rows (force=${FORCE})`);

  const started = Date.now();
  let updated = 0;
  let noData = 0;

  // Use a single transaction for speed.
  await db.exec('BEGIN');
  const stmt = await db.prepare(UPDATE_SQL);
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const soil = sampleSoilAt(rasters, row.lat, row.lon);
      if (soil == null) {
        noData++;
      } else {
        await stmt.run(
          soil.soil_ph_surface,
          soil.soil_clay_pct,
          soil.soil_sand_pct,
          soil.soil_silt_pct,
          soil.soil_organic_carbon,
          soil.soil_cec,
          soil.soil_nitrogen,
          soil.soil_bulk_density,
          soil.soil_coarse_fragments_pct,
          soil.soil_water_field_capacity,
          soil.soil_water_wilting_point,
          soil.soil_available_water,
          row.id
        );
        updated++;
      }

      if ((i + 1) % 2000 === 0 || i === rows.length - 1) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  [${i + 1}/${rows.length}] updated=${updated} no_data=${noData} (${elapsed}s)`);
      }
    }
    await stmt.finalize();
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }

  await db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. updated=${updated}, no_data=${noData}.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
