#!/usr/bin/env node
'use strict';

/**
 * compute-soil-moisture-index.js
 *
 * Fills climate_grid.soil_moisture_index using the de Martonne aridity index:
 *   AI = bio12_annual_precip / max(1, bio1_annual_mean_temp + 10)
 *
 * Interpretation (de Martonne scale):
 *   AI < 5    → Hyper-arid
 *   5–10      → Arid
 *   10–20     → Semi-arid
 *   20–30     → Sub-humid
 *   > 30      → Humid
 *
 * Stored as-is (float, no artificial 0-100 rescaling) so consumers can apply
 * their own thresholds. Negative values (T < -10°C) are clamped to 0.
 *
 * Usage:
 *   node compute-soil-moisture-index.js
 *   node compute-soil-moisture-index.js --force   # recompute all rows
 *   node compute-soil-moisture-index.js --limit=500
 */

const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = CORPUS_DB;
const FORCE = process.argv.includes('--force');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

async function main() {
  console.log('compute-soil-moisture-index.js');

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA busy_timeout = 30000');

  const where = FORCE
    ? 'WHERE bio12_annual_precip IS NOT NULL AND bio1_annual_mean_temp IS NOT NULL'
    : 'WHERE soil_moisture_index IS NULL AND bio12_annual_precip IS NOT NULL AND bio1_annual_mean_temp IS NOT NULL';

  let q = `SELECT id, bio12_annual_precip, bio1_annual_mean_temp FROM climate_grid ${where} ORDER BY id`;
  if (LIMIT > 0) q += ` LIMIT ${LIMIT}`;

  const rows = await db.all(q);
  console.log(`Computing for ${rows.length} rows (force=${FORCE})`);

  const stmt = await db.prepare('UPDATE climate_grid SET soil_moisture_index = ? WHERE id = ?');
  await db.exec('BEGIN');

  let updated = 0;
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const { id, bio12_annual_precip: precip, bio1_annual_mean_temp: temp } = rows[i];
    const denominator = Math.max(1, temp + 10);
    const ai = Math.max(0, precip / denominator);
    await stmt.run(Math.round(ai * 100) / 100, id);
    updated++;

    if ((i + 1) % 10000 === 0 || i === rows.length - 1) {
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${rows.length}] updated=${updated} (${s}s)`);
    }
  }

  await db.exec('COMMIT');
  await stmt.finalize();
  await db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();
  console.log(`\nDone. ${updated} rows updated.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
