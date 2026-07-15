#!/usr/bin/env node
'use strict';

/**
 * derive-soil-classes.js
 *
 * Fills two derived columns on climate_grid from existing SoilGrids data:
 *
 *   soil_texture_class   — USDA 12-class texture name from clay/sand/silt %.
 *                          Classification follows the standard USDA soil texture
 *                          triangle (Soil Survey Manual, Ch. 3).
 *
 *   soil_nutriments_0_10 — Trefle-compatible richness proxy (0=poor, 10=rich)
 *                          averaged from three equally-weighted normalised signals,
 *                          with caps chosen for cropland relevance (not peat bias):
 *                            nitrogen / 3  (capped at 1; 3 g/kg is high for mineral soil)
 *                            cec      / 25 (capped at 1; 25 cmol+/kg is rich)
 *                            soc      / 30 (capped at 1; 30 g/kg is the Mollisol ceiling)
 *                          Any missing signal is dropped from the average.
 *
 * Usage:
 *   node derive-soil-classes.js
 *   node derive-soil-classes.js --force      # recompute every row
 *   node derive-soil-classes.js --limit=500  # smoke test
 */

const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = CORPUS_DB;
const FORCE = process.argv.includes('--force');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

/**
 * USDA 12-class texture from clay/sand/silt percentages.
 * Boundaries from the USDA Soil Survey Manual texture triangle.
 * Inputs must sum to ~100; we assume SoilGrids-sourced data (already normalised).
 */
function usdaTextureClass(clay, sand, silt) {
  if (clay == null || sand == null || silt == null) return null;

  if (silt + 1.5 * clay < 15) return 'sand';
  if (silt + 2 * clay < 30) return 'loamy sand';
  if ((clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) ||
      (clay < 7 && silt < 50 && silt + 2 * clay >= 30)) return 'sandy loam';
  if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return 'loam';
  if ((silt >= 50 && clay >= 12 && clay < 27) ||
      (silt >= 50 && silt < 80 && clay < 12)) return 'silt loam';
  if (silt >= 80 && clay < 12) return 'silt';
  if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return 'sandy clay loam';
  if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return 'clay loam';
  if (clay >= 27 && clay < 40 && sand <= 20) return 'silty clay loam';
  if (clay >= 35 && sand > 45) return 'sandy clay';
  if (clay >= 40 && silt >= 40) return 'silty clay';
  if (clay >= 40 && sand <= 45 && silt < 40) return 'clay';
  return null;
}

function nutrimentsProxy(nitrogen, cec, soc) {
  const signals = [];
  if (nitrogen != null) signals.push(Math.min(1, nitrogen / 3));
  if (cec != null)      signals.push(Math.min(1, cec / 25));
  if (soc != null)      signals.push(Math.min(1, soc / 30));
  if (signals.length === 0) return null;
  const mean = signals.reduce((a, b) => a + b, 0) / signals.length;
  return Math.round(mean * 100) / 10; // 0-10 with 1 decimal
}

async function main() {
  console.log('derive-soil-classes.js');

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA busy_timeout = 30000');

  const where = FORCE
    ? 'WHERE soil_clay_pct IS NOT NULL'
    : `WHERE (soil_texture_class IS NULL OR soil_nutriments_0_10 IS NULL)
         AND soil_clay_pct IS NOT NULL`;

  let q = `SELECT id, soil_clay_pct, soil_sand_pct, soil_silt_pct,
                  soil_nitrogen, soil_cec, soil_organic_carbon
           FROM climate_grid ${where} ORDER BY id`;
  if (LIMIT > 0) q += ` LIMIT ${LIMIT}`;

  const rows = await db.all(q);
  console.log(`Deriving for ${rows.length} rows (force=${FORCE})`);

  const stmt = await db.prepare(
    'UPDATE climate_grid SET soil_texture_class = ?, soil_nutriments_0_10 = ? WHERE id = ?'
  );
  await db.exec('BEGIN');

  let textureSet = 0, nutrimentSet = 0;
  const t0 = Date.now();
  const classCounts = {};

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tex = usdaTextureClass(r.soil_clay_pct, r.soil_sand_pct, r.soil_silt_pct);
    const nut = nutrimentsProxy(r.soil_nitrogen, r.soil_cec, r.soil_organic_carbon);
    await stmt.run(tex, nut, r.id);
    if (tex) { textureSet++; classCounts[tex] = (classCounts[tex] || 0) + 1; }
    if (nut != null) nutrimentSet++;

    if ((i + 1) % 20000 === 0 || i === rows.length - 1) {
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${rows.length}] texture=${textureSet} nutriment=${nutrimentSet} (${s}s)`);
    }
  }

  await db.exec('COMMIT');
  await stmt.finalize();
  await db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();

  console.log(`\nDone. texture=${textureSet}, nutriments=${nutrimentSet}.`);
  console.log('USDA class distribution:');
  Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
