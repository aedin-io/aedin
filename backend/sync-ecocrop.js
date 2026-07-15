#!/usr/bin/env node
'use strict';

/**
 * sync-ecocrop.js
 *
 * Merges FAO ECOCROP growth-parameter data into the entities table,
 * complementing sync-trefle-entities.js.
 *
 * Scope: crop entities (primary_role='crop', parent_entity_id IS NULL).
 *
 * Source:
 *   A local CSV at data/ecocrop/ecocrop.csv with columns using the Ramirez-
 *   Villegas / ecocrop R package schema:
 *     SCIENTNAME, COMNAME, FAMNAME,
 *     TOPMN, TOPMX,       # optimal temperature °C
 *     TMIN, TMAX,         # absolute temperature °C
 *     ROPMN, ROPMX,       # optimal annual rainfall mm
 *     RMIN, RMAX,         # absolute annual rainfall mm
 *     PHOPMN, PHOPMX,     # optimal pH
 *     PHMIN, PHMAX,       # absolute pH
 *     TEXT, DEP, FER, SAL, DRA,   # soil texture, depth, fertility, salinity, drainage
 *     LIEX, PHOT,                 # light intensity, photoperiod
 *     GMIN, GMAX, LATOPMN, LATOPMX, ALTMX
 *
 *   Obtain via:
 *     bash download-ecocrop.sh
 *
 * Matching:
 *   Exact scientific-name match (case-insensitive, trimmed).
 *   Falls back to `Genus species` (first two tokens) for entities with subspecies.
 *
 * Default behaviour: backfill-only. Only NULL columns on a given entity get
 * written; existing Trefle-sourced values are preserved.
 *
 * Usage:
 *   node sync-ecocrop.js                # backfill NULL fields only
 *   node sync-ecocrop.js --force        # overwrite existing values
 *   node sync-ecocrop.js --limit=100
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { expandEcoCropKeys } = require('./lib/ecocrop-synonyms');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const CSV_PATH = path.join(__dirname, 'data', 'ecocrop', 'ecocrop.csv');

const FORCE = process.argv.includes('--force');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

// ── ECOCROP → entity-column mapping ─────────────────────────────────────────

// ECOCROP uses single-letter codes, sometimes with ranges ("M H" = medium-to-heavy).
// For mapping we take the best (rightmost) code in a range — it represents the
// optimal end of the tolerated range.
//
// Entities schema uses INTEGER 1-10 for soil_texture / optimal_soil_texture
// (Trefle convention). ECOCROP L/M/H map to 3/6/9 on that scale.
const TEXTURE_INT_MAP = {
  L: 3,  // light / sandy
  M: 6,  // medium / loamy
  H: 9,  // heavy / clay
};

const ORDINAL_0_10 = {
  L: 2,
  M: 5,
  H: 8,
};

function norm(s) {
  return s == null ? '' : String(s).trim().toLowerCase();
}

// ECOCROP TEXT / DEP / FER / SAL fields can contain multiple single-letter
// codes (e.g. "M O" = medium-or-organic, "l m" = light-or-medium, case
// inconsistent across rows). For categorical mapping we scan tokens in order
// and return the first that matches `allowed`; `allowed` is a Set of
// single-letter keys (already uppercase). Tokens outside the set (e.g. "O"
// for organic/peat, "W" for wet) are skipped rather than crashing the
// lookup.
function pickCode(v, allowed) {
  if (v == null) return null;
  const tokens = String(v).trim().toUpperCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (!allowed || allowed.has(t)) return t;
  }
  return null;
}
const LMH = new Set(['L', 'M', 'H']);

// LIG column holds a numeric range "0 4" on a 0-4 scale. Take the top of the
// range (optimal light demand) and rescale to 0-10 for Trefle compatibility.
function parseLight(v) {
  if (v == null) return null;
  const nums = String(v).trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
  if (nums.length === 0) return null;
  const top = Math.max(...nums);
  return Math.max(0, Math.min(10, Math.round((top / 4) * 10)));
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function mapEcoCropRow(row) {
  // Temperature (optimal preferred, fall back to absolute range)
  const tmin = num(row.TOPMN) ?? num(row.TMIN);
  const tmax = num(row.TOPMX) ?? num(row.TMAX);
  // Rainfall
  const rmin = num(row.ROPMN) ?? num(row.RMIN);
  const rmax = num(row.ROPMX) ?? num(row.RMAX);
  // pH
  const phmin = num(row.PHOPMN) ?? num(row.PHMIN);
  const phmax = num(row.PHOPMX) ?? num(row.PHMAX);

  const texture   = TEXTURE_INT_MAP[pickCode(row.TEXT, LMH)] ?? null;
  const fertility = ORDINAL_0_10[pickCode(row.FER, LMH)] ?? null;
  const salinity  = ORDINAL_0_10[pickCode(row.SAL, LMH)] ?? null;
  const light     = parseLight(row.LIG);

  return {
    // dual-family mapping, same pattern as sync-trefle-entities
    optimal_temp_min: tmin, optimal_temp_max: tmax,
    min_temp_c: tmin, max_temp_c: tmax,

    optimal_precip_min: rmin, optimal_precip_max: rmax,
    min_precipitation_mm: rmin, max_precipitation_mm: rmax,

    optimal_ph_min: phmin, optimal_ph_max: phmax,
    ph_min: phmin, ph_max: phmax,

    optimal_soil_texture: texture,   // integer 1-10 matches entities schema + Trefle scale
    soil_texture: texture,
    soil_nutriments: fertility,
    soil_salinity: salinity,
    optimal_light: light,
    light_requirement: light,

    ecocrop_family: row.FAMNAME || null,
  };
}

// ── CSV load + lookup build ─────────────────────────────────────────────────

function loadEcoCropCsv() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`\nMissing ${CSV_PATH}. See header of this file or run:`);
    console.error('  bash download-ecocrop.sh');
    process.exit(1);
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  const byName = new Map();
  for (const r of rows) {
    for (const k of expandEcoCropKeys(r.SCIENTNAME)) {
      if (!byName.has(k)) byName.set(k, r);
    }
  }
  return { rows, byName };
}

// ── Main sync loop ──────────────────────────────────────────────────────────

async function main() {
  console.log('sync-ecocrop.js');
  console.log(`  CSV:   ${CSV_PATH}`);
  console.log(`  force: ${FORCE}`);

  const { rows: ecoRows, byName } = loadEcoCropCsv();
  console.log(`  Loaded ${ecoRows.length} ECOCROP rows (${byName.size} unique name keys)`);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA busy_timeout = 30000');

  const entCols = new Set(
    (await db.all('PRAGMA table_info(entities)')).map(c => c.name)
  );
  // Skip derived/foreign columns not in the schema (e.g. optimal_soil_texture_class
  // may not exist yet — it's the planned consolidated column).

  let q = `SELECT id, scientific_name FROM entities
           WHERE primary_role = 'crop' AND parent_entity_id IS NULL
             AND scientific_name IS NOT NULL`;
  if (LIMIT > 0) q += ` LIMIT ${LIMIT}`;
  const crops = await db.all(q);
  console.log(`  Crops to check: ${crops.length}`);

  let matched = 0, updated = 0, wroteFields = 0, unmatched = 0;

  for (const e of crops) {
    const key = norm(e.scientific_name);
    let row = byName.get(key);
    if (!row) {
      const tokens = key.split(/\s+/);
      if (tokens.length >= 2) row = byName.get(`${tokens[0]} ${tokens[1]}`);
    }
    if (!row) { unmatched++; continue; }
    matched++;

    const mapped = mapEcoCropRow(row);
    const cols = Object.keys(mapped).filter(c => entCols.has(c));
    if (cols.length === 0) continue;

    let existing = null;
    if (!FORCE) {
      existing = await db.get(`SELECT ${cols.join(',')} FROM entities WHERE id = ?`, e.id);
    }

    const sets = [], vals = [];
    for (const c of cols) {
      const v = mapped[c];
      if (v == null) continue;
      if (!FORCE && existing && existing[c] != null) continue;
      sets.push(`${c} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) continue;

    sets.push("updated_at = datetime('now')");
    await db.run(
      `UPDATE entities SET ${sets.join(', ')} WHERE id = ?`,
      [...vals, e.id]
    );
    updated++;
    wroteFields += sets.length - 1;
  }

  await db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();

  console.log('');
  console.log(`Matched:     ${matched}/${crops.length}`);
  console.log(`Unmatched:   ${unmatched}`);
  console.log(`Rows updated:${updated}`);
  console.log(`Fields written:${wroteFields}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
