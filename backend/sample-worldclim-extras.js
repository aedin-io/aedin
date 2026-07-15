#!/usr/bin/env node
'use strict';

/**
 * sample-worldclim-extras.js
 *
 * Samples WorldClim v2.1 10-arcmin rasters for three variables that sync-climate-grid.js
 * did not fetch, and populates the corresponding climate_grid columns:
 *
 *   srad (12 monthly rasters, kJ m⁻² day⁻¹) → monthly_solar_radiation, mean_solar_radiation
 *   vapr (12 monthly rasters, kPa)          → monthly_vapor_pressure, mean_vapor_pressure
 *   elev (single raster, m)                 → elevation_m
 *
 * Also derives relative humidity from vapor pressure + monthly_temp_{high,low}
 * using the Tetens saturation-vapor-pressure formula, populating monthly_humidity
 * and mean_relative_humidity.
 *
 * Download the rasters first (sandbox allows geodata.ucdavis.edu):
 *   cd data/worldclim
 *   for v in srad vapr elev; do
 *     curl -L -o wc2.1_10m_${v}.zip "https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_${v}.zip"
 *     unzip wc2.1_10m_${v}.zip && rm wc2.1_10m_${v}.zip
 *   done
 *
 * Usage:
 *   node sample-worldclim-extras.js [--limit=N] [--offset=N] [--force] [--lat-min=...] [--lat-max=...]
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { fromFile } = require('geotiff');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const WORLDCLIM_DIR = path.join(__dirname, 'data', 'worldclim');

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const OFFSET = parseInt(process.argv.find(a => a.startsWith('--offset='))?.split('=')[1] || '0', 10);
const FORCE = process.argv.includes('--force');
const LAT_MIN = parseFloat(process.argv.find(a => a.startsWith('--lat-min='))?.split('=')[1] || '-90');
const LAT_MAX = parseFloat(process.argv.find(a => a.startsWith('--lat-max='))?.split('=')[1] || '90');

// ── Raster loading ──────────────────────────────────────────────────────────

async function loadRaster(filename) {
  const filepath = path.join(WORLDCLIM_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`  Missing: ${filename}`);
    return null;
  }
  const tiff = await fromFile(filepath);
  const image = await tiff.getImage();
  const rasterData = await image.readRasters();
  const bbox = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  return {
    data: rasterData[0],
    bbox,
    width,
    height,
    pixelWidth: (bbox[2] - bbox[0]) / width,
    pixelHeight: (bbox[3] - bbox[1]) / height,
    nodata: image.getGDALNoData(),
  };
}

function sampleRaster(raster, lat, lon) {
  if (!raster) return null;
  const col = Math.floor((lon - raster.bbox[0]) / raster.pixelWidth);
  const row = Math.floor((raster.bbox[3] - lat) / raster.pixelHeight);
  if (col < 0 || col >= raster.width || row < 0 || row >= raster.height) return null;
  const val = raster.data[row * raster.width + col];
  if (val === raster.nodata || val === -9999 || val < -1e+30 || Number.isNaN(val)) return null;
  return val;
}

async function loadMonthlyRasters(variable) {
  const rasters = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const r = await loadRaster(`wc2.1_10m_${variable}_${mm}.tif`);
    rasters.push(r);
  }
  const loaded = rasters.filter(Boolean).length;
  console.log(`  Loaded ${loaded}/12 ${variable} rasters`);
  return rasters;
}

// ── Humidity derivation ─────────────────────────────────────────────────────

/**
 * Saturation vapor pressure (kPa) at air temperature T (°C) — Tetens formula.
 */
function saturationVaporPressure(tempC) {
  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

/**
 * Relative humidity (%) from actual vapor pressure e (kPa) and air temp (°C).
 * Uses mean of daily max/min saturation pressures, which is the standard
 * approximation when only monthly mean high/low temps are available
 * (FAO-56 equation 19).
 */
function relativeHumidityFromVapr(vaprKpa, tHigh, tLow) {
  if (vaprKpa == null || tHigh == null || tLow == null) return null;
  const esMax = saturationVaporPressure(tHigh);
  const esMin = saturationVaporPressure(tLow);
  const esMean = (esMax + esMin) / 2;
  if (esMean <= 0) return null;
  const rh = (vaprKpa / esMean) * 100;
  // Clamp to physically meaningful range
  return Math.max(0, Math.min(100, rh));
}

// ── Main ────────────────────────────────────────────────────────────────────

const round1 = v => v == null ? null : Math.round(v * 10) / 10;
const round2 = v => v == null ? null : Math.round(v * 100) / 100;

async function main() {
  console.log('sample-worldclim-extras.js');
  console.log(`  WorldClim dir: ${WORLDCLIM_DIR}`);

  console.log('Loading elevation raster...');
  const elevRaster = await loadRaster('wc2.1_10m_elev.tif');

  console.log('Loading solar radiation rasters...');
  const sradRasters = await loadMonthlyRasters('srad');

  console.log('Loading vapor pressure rasters...');
  const vaprRasters = await loadMonthlyRasters('vapr');

  const haveElev = elevRaster != null;
  const haveSrad = sradRasters.some(Boolean);
  const haveVapr = vaprRasters.some(Boolean);

  if (!haveElev && !haveSrad && !haveVapr) {
    console.log('\nNo rasters found. Download them first:');
    console.log('  cd data/worldclim');
    console.log('  for v in srad vapr elev; do');
    console.log('    curl -L -o wc2.1_10m_${v}.zip "https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_${v}.zip"');
    console.log('    unzip wc2.1_10m_${v}.zip && rm wc2.1_10m_${v}.zip');
    console.log('  done');
    return;
  }

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA busy_timeout = 30000');

  // Rows that still need any of these fields (unless --force)
  const where = FORCE
    ? `WHERE lat BETWEEN ${LAT_MIN} AND ${LAT_MAX}`
    : `WHERE lat BETWEEN ${LAT_MIN} AND ${LAT_MAX} AND (
         elevation_m IS NULL OR
         mean_solar_radiation IS NULL OR
         mean_vapor_pressure IS NULL OR
         mean_relative_humidity IS NULL
       )`;

  let query = `SELECT id, lat, lon, monthly_temp_high, monthly_temp_low FROM climate_grid ${where} ORDER BY id`;
  if (LIMIT > 0) query += ` LIMIT ${LIMIT}`;
  if (OFFSET > 0) query += ` OFFSET ${OFFSET}`;

  const rows = await db.all(query);
  console.log(`\nSampling rasters for ${rows.length} rows (force=${FORCE})`);

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sets = [];
    const params = [];

    // Elevation
    if (haveElev) {
      const elev = sampleRaster(elevRaster, row.lat, row.lon);
      if (elev != null) {
        sets.push('elevation_m = ?');
        params.push(Math.round(elev));
      }
    }

    // Monthly solar radiation
    let monthlySrad = null;
    if (haveSrad) {
      monthlySrad = sradRasters.map(r => {
        const v = sampleRaster(r, row.lat, row.lon);
        return v != null ? round1(v) : null;
      });
      const valid = monthlySrad.filter(v => v != null);
      if (valid.length > 0) {
        const mean = round1(valid.reduce((a, b) => a + b, 0) / valid.length);
        sets.push('monthly_solar_radiation = ?', 'mean_solar_radiation = ?');
        params.push(JSON.stringify(monthlySrad), mean);
      } else {
        monthlySrad = null;
      }
    }

    // Monthly vapor pressure
    let monthlyVapr = null;
    if (haveVapr) {
      monthlyVapr = vaprRasters.map(r => {
        const v = sampleRaster(r, row.lat, row.lon);
        return v != null ? round2(v) : null;
      });
      const valid = monthlyVapr.filter(v => v != null);
      if (valid.length > 0) {
        const mean = round2(valid.reduce((a, b) => a + b, 0) / valid.length);
        sets.push('monthly_vapor_pressure = ?', 'mean_vapor_pressure = ?');
        params.push(JSON.stringify(monthlyVapr), mean);
      } else {
        monthlyVapr = null;
      }
    }

    // Derive relative humidity from vapr + monthly temps (Tetens)
    if (monthlyVapr && row.monthly_temp_high && row.monthly_temp_low) {
      try {
        const tHigh = JSON.parse(row.monthly_temp_high);
        const tLow = JSON.parse(row.monthly_temp_low);
        if (Array.isArray(tHigh) && Array.isArray(tLow) && tHigh.length === 12) {
          const monthlyRh = monthlyVapr.map((v, m) =>
            round1(relativeHumidityFromVapr(v, tHigh[m], tLow[m]))
          );
          const validRh = monthlyRh.filter(v => v != null);
          if (validRh.length > 0) {
            const meanRh = round1(validRh.reduce((a, b) => a + b, 0) / validRh.length);
            sets.push('monthly_humidity = ?', 'mean_relative_humidity = ?');
            params.push(JSON.stringify(monthlyRh), meanRh);
          }
        }
      } catch (_) { /* ignore bad JSON */ }
    }

    if (sets.length > 0) {
      params.push(row.id);
      await db.run(`UPDATE climate_grid SET ${sets.join(', ')} WHERE id = ?`, params);
      updated++;
    } else {
      skipped++;
    }

    if ((i + 1) % 1000 === 0 || i === rows.length - 1) {
      console.log(`  [${i + 1}/${rows.length}] updated=${updated} skipped=${skipped}`);
    }
  }

  await db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();
  console.log(`\nDone. ${updated} rows updated, ${skipped} skipped.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
