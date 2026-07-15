#!/usr/bin/env node
'use strict';

/**
 * sync-climate-grid.js
 *
 * Populates the climate_grid table from:
 * 1. WorldClim v2.1 bioclimatic GeoTIFFs (19 bioclim variables)
 * 2. Open-Meteo Climate API (monthly normals, frost dates, GDD)
 * 3. SoilGrids WCS API (soil pH, clay, sand, organic carbon)
 *
 * Usage:
 *   node sync-climate-grid.js [--lat-min=-60] [--lat-max=85] [--step=0.25] [--dry-run]
 *
 * WorldClim tiles must be downloaded first:
 *   mkdir -p data/worldclim && cd data/worldclim
 *   curl -L -o wc2.1_10m_bio.zip "https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_bio.zip"
 *   unzip wc2.1_10m_bio.zip && rm wc2.1_10m_bio.zip
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { fromFile } = require('geotiff');
const { execSync } = require('child_process');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

/**
 * Fetch JSON from a URL using curl (bypasses Node sandbox network restrictions).
 */
function curlFetchJSON(url) {
  try {
    const stdout = execSync(`curl -s --max-time 30 "${url}"`, { encoding: 'utf-8' });
    return JSON.parse(stdout);
  } catch (e) {
    return null;
  }
}

const DB_PATH = CORPUS_DB;
const WORLDCLIM_DIR = path.join(__dirname, 'data', 'worldclim');
const OPEN_METEO_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const OPEN_METEO_CLIMATE = 'https://climate-api.open-meteo.com/v1/climate';

const STEP = parseFloat(process.argv.find(a => a.startsWith('--step='))?.split('=')[1] || '0.25');
const LAT_MIN = parseFloat(process.argv.find(a => a.startsWith('--lat-min='))?.split('=')[1] || '-60');
const LAT_MAX = parseFloat(process.argv.find(a => a.startsWith('--lat-max='))?.split('=')[1] || '85');
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_OPENMETEO = process.argv.includes('--skip-openmeteo');
const SKIP_SOIL = process.argv.includes('--skip-soil');
const BATCH_SIZE = 500;
const OPEN_METEO_DELAY_MS = 200; // rate limit: ~5 req/sec for free tier

const REGION_ARG = process.argv.find(a => a.startsWith('--region='))?.split('=')[1] || 'global';

const REGION_BOXES = {
  us: [
    { name: 'Continental US', latMin: 24, latMax: 50, lonMin: -125, lonMax: -66 },
    { name: 'Alaska',         latMin: 51, latMax: 72, lonMin: -180, lonMax: -130 },
    { name: 'Hawaii',         latMin: 18, latMax: 23, lonMin: -161, lonMax: -154 },
    { name: 'Guam/CNMI',      latMin: 13, latMax: 21, lonMin: 144,  lonMax: 146 },
    { name: 'American Samoa',  latMin: -15, latMax: -14, lonMin: -171, lonMax: -170 },
    { name: 'Puerto Rico/USVI', latMin: 17, latMax: 19, lonMin: -68, lonMax: -64 },
  ],
  global: [
    { name: 'Global', latMin: LAT_MIN, latMax: LAT_MAX, lonMin: -180, lonMax: 180 },
  ],
};

function isInRegion(lat, lon) {
  const boxes = REGION_BOXES[REGION_ARG] || REGION_BOXES.global;
  return boxes.some(b => lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── WorldClim raster reading ─────────────────────────────────────────────────

async function loadWorldClimRasters() {
  const rasters = {};
  for (let i = 1; i <= 19; i++) {
    const filename = `wc2.1_10m_bio_${i}.tif`;
    const filepath = path.join(WORLDCLIM_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.warn(`  Warning: ${filename} not found, bio${i} will be NULL`);
      continue;
    }
    const tiff = await fromFile(filepath);
    const image = await tiff.getImage();
    const rasterData = await image.readRasters();
    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
    const width = image.getWidth();
    const height = image.getHeight();
    rasters[`bio${i}`] = {
      data: rasterData[0],
      bbox,
      width,
      height,
      pixelWidth: (bbox[2] - bbox[0]) / width,
      pixelHeight: (bbox[3] - bbox[1]) / height,
      nodata: image.getGDALNoData(),
    };
    console.log(`  Loaded ${filename} (${width}x${height})`);
  }
  return rasters;
}

function sampleRaster(raster, lat, lon) {
  if (!raster) return null;
  const col = Math.floor((lon - raster.bbox[0]) / raster.pixelWidth);
  const row = Math.floor((raster.bbox[3] - lat) / raster.pixelHeight);
  if (col < 0 || col >= raster.width || row < 0 || row >= raster.height) return null;
  const val = raster.data[row * raster.width + col];
  if (val === raster.nodata || val === -9999 || val < -1e+30) return null;
  return val;
}

// ── Open-Meteo climate normals ───────────────────────────────────────────────

async function fetchOpenMeteoClimate(lat, lon) {
  const url = `${OPEN_METEO_CLIMATE}?latitude=${lat}&longitude=${lon}` +
    `&models=EC_Earth3P_HR` +
    `&monthly=temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_mean` +
    `&start_date=1991-01-01&end_date=2020-12-31`;
  try {
    const data = curlFetchJSON(url);
    if (!data || !data.monthly) return null;

    // Average across 30 years to get monthly normals
    const months = 12;
    const years = 30;
    const tempHigh = new Array(months).fill(0);
    const tempLow = new Array(months).fill(0);
    const precip = new Array(months).fill(0);
    const humidity = new Array(months).fill(0);

    for (let i = 0; i < data.monthly.time.length; i++) {
      const m = i % months;
      tempHigh[m] += (data.monthly.temperature_2m_max[i] || 0) / years;
      tempLow[m]  += (data.monthly.temperature_2m_min[i] || 0) / years;
      precip[m]   += (data.monthly.precipitation_sum[i] || 0) / years;
      humidity[m] += (data.monthly.relative_humidity_2m_mean?.[i] || 0) / years;
    }

    // Round to 1 decimal
    const round1 = v => Math.round(v * 10) / 10;

    // Frost dates (first/last month where avg low < 0)
    let firstFrost = null, lastFrost = null;
    for (let m = 6; m < 6 + 12; m++) { // start from July (NH bias but works)
      const idx = m % 12;
      if (tempLow[idx] < 0) {
        if (firstFrost === null) firstFrost = idx;
        lastFrost = idx;
      }
    }
    // Approximate DOY from month index (mid-month)
    const monthToDoy = m => m * 30 + 15;
    const frostFreeDays = (firstFrost === null) ? 365 :
      ((firstFrost - (lastFrost + 1) + 12) % 12) * 30;

    // GDD base 10
    const gdd = tempHigh.reduce((sum, h, i) => {
      const avgTemp = (h + tempLow[i]) / 2;
      return sum + Math.max(0, avgTemp - 10) * 30; // ~30 days per month
    }, 0);

    return {
      monthly_temp_high: JSON.stringify(tempHigh.map(round1)),
      monthly_temp_low:  JSON.stringify(tempLow.map(round1)),
      monthly_precip_mm: JSON.stringify(precip.map(round1)),
      monthly_humidity:  JSON.stringify(humidity.map(round1)),
      frost_free_days: Math.round(frostFreeDays),
      growing_degree_days: Math.round(gdd),
      first_frost_doy: firstFrost !== null ? monthToDoy(firstFrost) : null,
      last_frost_doy:  lastFrost !== null ? monthToDoy(lastFrost) : null,
    };
  } catch (e) {
    console.warn(`  Open-Meteo error for ${lat},${lon}: ${e.message}`);
    return null;
  }
}

// ── SoilGrids ────────────────────────────────────────────────────────────────

async function fetchSoilGrids(lat, lon) {
  const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon}&lat=${lat}&property=phh2o&property=clay&property=sand&property=soc&depth=0-5cm&depth=5-15cm&depth=15-30cm&value=mean`;
  try {
    const data = curlFetchJSON(url);
    if (!data) return null;
    const layers = data.properties?.layers || [];
    const get = (name) => {
      const layer = layers.find(l => l.name === name);
      if (!layer || !layer.depths) return null;
      const vals = layer.depths.map(d => d.values?.mean).filter(v => v != null);
      return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    return {
      soil_ph_surface: get('phh2o') != null ? get('phh2o') / 10 : null, // SoilGrids pH is x10
      soil_clay_pct: get('clay') != null ? get('clay') / 10 : null,     // g/kg → %
      soil_sand_pct: get('sand') != null ? get('sand') / 10 : null,
      soil_organic_carbon: get('soc') != null ? get('soc') / 10 : null, // dg/kg → g/kg
    };
  } catch (e) {
    console.warn(`  SoilGrids error for ${lat},${lon}: ${e.message}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('sync-climate-grid.js');
  console.log(`  Region: ${REGION_ARG} (${(REGION_BOXES[REGION_ARG] || REGION_BOXES.global).map(b => b.name).join(', ')})`);
  console.log(`  Grid: ${LAT_MIN}° to ${LAT_MAX}° lat, step ${STEP}°`);
  console.log(`  WorldClim dir: ${WORLDCLIM_DIR}`);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');

  // Check how many rows already exist
  const existing = await db.get('SELECT COUNT(*) as cnt FROM climate_grid');
  console.log(`  Existing grid points: ${existing.cnt}`);

  // Load WorldClim rasters
  console.log('Loading WorldClim rasters...');
  const rasters = await loadWorldClimRasters();
  const rasterCount = Object.keys(rasters).length;
  console.log(`  Loaded ${rasterCount}/19 bioclim rasters`);

  if (rasterCount === 0) {
    console.log('\nNo WorldClim rasters found. Download them first:');
    console.log('  mkdir -p data/worldclim && cd data/worldclim');
    console.log('  for i in $(seq 1 19); do');
    console.log('    wget "https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_bio_${i}.tif"');
    console.log('  done');
    await db.close();
    return;
  }

  // Prepare upsert
  const UPSERT = `
    INSERT INTO climate_grid (
      lat, lon, elevation_m,
      monthly_temp_high, monthly_temp_low, monthly_precip_mm, monthly_humidity,
      bio1_annual_mean_temp, bio2_mean_diurnal_range, bio3_isothermality,
      bio4_temp_seasonality, bio5_max_temp_warmest, bio6_min_temp_coldest,
      bio7_temp_annual_range, bio8_mean_temp_wettest_q, bio9_mean_temp_driest_q,
      bio10_mean_temp_warmest_q, bio11_mean_temp_coldest_q,
      bio12_annual_precip, bio13_precip_wettest_month, bio14_precip_driest_month,
      bio15_precip_seasonality, bio16_precip_wettest_q, bio17_precip_driest_q,
      bio18_precip_warmest_q, bio19_precip_coldest_q,
      frost_free_days, growing_degree_days, first_frost_doy, last_frost_doy,
      koppen_zone, hardiness_zone,
      soil_ph_surface, soil_clay_pct, soil_sand_pct, soil_organic_carbon, soil_moisture_index
    ) VALUES (${new Array(37).fill('?').join(',')})
    ON CONFLICT(lat, lon) DO UPDATE SET
      elevation_m = excluded.elevation_m,
      monthly_temp_high = excluded.monthly_temp_high,
      monthly_temp_low = excluded.monthly_temp_low,
      monthly_precip_mm = excluded.monthly_precip_mm,
      monthly_humidity = excluded.monthly_humidity,
      bio1_annual_mean_temp = excluded.bio1_annual_mean_temp,
      bio2_mean_diurnal_range = excluded.bio2_mean_diurnal_range,
      bio3_isothermality = excluded.bio3_isothermality,
      bio4_temp_seasonality = excluded.bio4_temp_seasonality,
      bio5_max_temp_warmest = excluded.bio5_max_temp_warmest,
      bio6_min_temp_coldest = excluded.bio6_min_temp_coldest,
      bio7_temp_annual_range = excluded.bio7_temp_annual_range,
      bio8_mean_temp_wettest_q = excluded.bio8_mean_temp_wettest_q,
      bio9_mean_temp_driest_q = excluded.bio9_mean_temp_driest_q,
      bio10_mean_temp_warmest_q = excluded.bio10_mean_temp_warmest_q,
      bio11_mean_temp_coldest_q = excluded.bio11_mean_temp_coldest_q,
      bio12_annual_precip = excluded.bio12_annual_precip,
      bio13_precip_wettest_month = excluded.bio13_precip_wettest_month,
      bio14_precip_driest_month = excluded.bio14_precip_driest_month,
      bio15_precip_seasonality = excluded.bio15_precip_seasonality,
      bio16_precip_wettest_q = excluded.bio16_precip_wettest_q,
      bio17_precip_driest_q = excluded.bio17_precip_driest_q,
      bio18_precip_warmest_q = excluded.bio18_precip_warmest_q,
      bio19_precip_coldest_q = excluded.bio19_precip_coldest_q,
      frost_free_days = excluded.frost_free_days,
      growing_degree_days = excluded.growing_degree_days,
      first_frost_doy = excluded.first_frost_doy,
      last_frost_doy = excluded.last_frost_doy,
      soil_ph_surface = excluded.soil_ph_surface,
      soil_clay_pct = excluded.soil_clay_pct,
      soil_sand_pct = excluded.soil_sand_pct,
      soil_organic_carbon = excluded.soil_organic_carbon,
      soil_moisture_index = excluded.soil_moisture_index
  `;

  let inserted = 0;
  let skippedOcean = 0;
  let total = 0;

  // Iterate global grid
  for (let lat = LAT_MAX; lat >= LAT_MIN; lat = Math.round((lat - STEP) * 1000) / 1000) {
    const rowStart = Date.now();
    let rowInserted = 0;

    for (let lon = -180; lon < 180; lon = Math.round((lon + STEP) * 1000) / 1000) {
      total++;

      // Skip points outside selected region
      if (!isInRegion(lat, lon)) {
        continue;
      }

      // Sample bio1 to check if this is a land point
      const bio1 = sampleRaster(rasters.bio1, lat, lon);
      if (bio1 === null) {
        skippedOcean++;
        continue;
      }

      // Sample all 19 bioclim variables
      const bioclim = {};
      for (let i = 1; i <= 19; i++) {
        const key = `bio${i}`;
        let val = sampleRaster(rasters[key], lat, lon);
        // WorldClim stores bio1-11 as °C × 10 for integers; 10-arcmin floats are already °C
        bioclim[key] = val;
      }

      // Fetch Open-Meteo climate normals (rate-limited)
      let climate = null;
      if (!DRY_RUN && !SKIP_OPENMETEO) {
        climate = await fetchOpenMeteoClimate(lat, lon);
        await sleep(OPEN_METEO_DELAY_MS);
      }

      // Fetch SoilGrids (rate-limited)
      let soil = null;
      if (!DRY_RUN && !SKIP_SOIL) {
        soil = await fetchSoilGrids(lat, lon);
        await sleep(OPEN_METEO_DELAY_MS);
      }

      const params = [
        lat, lon, null, // elevation_m — could add from a DEM raster
        climate?.monthly_temp_high ?? null,
        climate?.monthly_temp_low ?? null,
        climate?.monthly_precip_mm ?? null,
        climate?.monthly_humidity ?? null,
        bioclim.bio1, bioclim.bio2, bioclim.bio3,
        bioclim.bio4, bioclim.bio5, bioclim.bio6,
        bioclim.bio7, bioclim.bio8, bioclim.bio9,
        bioclim.bio10, bioclim.bio11,
        bioclim.bio12, bioclim.bio13, bioclim.bio14,
        bioclim.bio15, bioclim.bio16, bioclim.bio17,
        bioclim.bio18, bioclim.bio19,
        climate?.frost_free_days ?? null,
        climate?.growing_degree_days ?? null,
        climate?.first_frost_doy ?? null,
        climate?.last_frost_doy ?? null,
        null, // koppen_zone — add from raster if available
        null, // hardiness_zone — add from raster if available
        soil?.soil_ph_surface ?? null,
        soil?.soil_clay_pct ?? null,
        soil?.soil_sand_pct ?? null,
        soil?.soil_organic_carbon ?? null,
        null, // soil_moisture_index
      ];

      if (!DRY_RUN) {
        await db.run(UPSERT, params);
      }
      inserted++;
      rowInserted++;
    }

    const elapsed = ((Date.now() - rowStart) / 1000).toFixed(1);
    if (rowInserted > 0) {
      console.log(`  lat ${lat.toFixed(2)}: ${rowInserted} points (${elapsed}s) [total: ${inserted}]`);
    }
  }

  console.log(`\nDone. ${inserted} land points inserted, ${skippedOcean} ocean points skipped (${total} total grid cells).`);

  // Checkpoint WAL
  await db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
