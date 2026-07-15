#!/usr/bin/env node
'use strict';

/**
 * sample-bedrock-depth.js
 *
 * Samples the OpenLandMap "Depth to Bedrock" (BDTICM) 1 km raster and
 * populates soil_depth_bedrock_cm on climate_grid.
 *
 * Source: Shangguan, Hengl et al. 2017, CC-BY 4.0.
 * Download: bash download-bedrock.sh
 *
 * Usage:
 *   node sample-bedrock-depth.js
 *   node sample-bedrock-depth.js --force     # re-sample every row
 *   node sample-bedrock-depth.js --limit=500
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { fromFile } = require('geotiff');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const BEDROCK_DIR = path.join(__dirname, 'data', 'openlandmap');
const BEDROCK_FILE = path.join(BEDROCK_DIR, 'bdticm.tif');

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const FORCE = process.argv.includes('--force');

async function loadRaster(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const tiff = await fromFile(filepath);
  const image = await tiff.getImage();
  const data = (await image.readRasters())[0];
  const bbox = image.getBoundingBox();
  return {
    data,
    bbox,
    width: image.getWidth(),
    height: image.getHeight(),
    pixelWidth: (bbox[2] - bbox[0]) / image.getWidth(),
    pixelHeight: (bbox[3] - bbox[1]) / image.getHeight(),
    nodata: image.getGDALNoData(),
  };
}

function sampleRaster(r, lat, lon) {
  if (!r) return null;
  if (lon < r.bbox[0] || lon > r.bbox[2] || lat < r.bbox[1] || lat > r.bbox[3]) return null;
  const col = Math.floor((lon - r.bbox[0]) / r.pixelWidth);
  const row = Math.floor((r.bbox[3] - lat) / r.pixelHeight);
  if (col < 0 || col >= r.width || row < 0 || row >= r.height) return null;
  const v = r.data[row * r.width + col];
  if (v === r.nodata || v === -9999 || v < -1e+30 || Number.isNaN(v)) return null;
  return v;
}

async function main() {
  console.log('sample-bedrock-depth.js');
  console.log(`  Raster: ${BEDROCK_FILE}`);

  if (!fs.existsSync(BEDROCK_FILE)) {
    console.error(`\nMissing ${BEDROCK_FILE}. Run: bash download-bedrock.sh`);
    process.exit(1);
  }

  const raster = await loadRaster(BEDROCK_FILE);
  console.log(`  Loaded raster ${raster.width}x${raster.height}, bbox=${raster.bbox.map(n => n.toFixed(2)).join(',')}`);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA busy_timeout = 30000');

  const where = FORCE ? 'WHERE 1=1' : 'WHERE soil_depth_bedrock_cm IS NULL';
  let q = `SELECT id, lat, lon FROM climate_grid ${where} ORDER BY id`;
  if (LIMIT > 0) q += ` LIMIT ${LIMIT}`;
  const rows = await db.all(q);
  console.log(`\nSampling ${rows.length} rows (force=${FORCE})`);

  const stmt = await db.prepare('UPDATE climate_grid SET soil_depth_bedrock_cm = ? WHERE id = ?');
  await db.exec('BEGIN');
  let updated = 0, noData = 0;
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const v = sampleRaster(raster, row.lat, row.lon);
    if (v != null) {
      await stmt.run(Math.round(v * 10) / 10, row.id);
      updated++;
    } else {
      noData++;
    }
    if ((i + 1) % 2000 === 0 || i === rows.length - 1) {
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${rows.length}] updated=${updated} no_data=${noData} (${s}s)`);
    }
  }

  await db.exec('COMMIT');
  await stmt.finalize();
  await db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();
  console.log(`\nDone. updated=${updated}, no_data=${noData}.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
