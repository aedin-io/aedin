#!/usr/bin/env node
'use strict';
/** fetch-trefle-sim.js — run-once idempotent cacher of Trefle species detail for the sim plant
 *  population (source #2 of the cascade). Resolves by NAME (stored trefle_id is stale), verifies the
 *  binomial, caches raw species data to trefle-sim-cache/. Usage: [--limit=N] [--refresh]. */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { matchSpecies } = require('./lib/trefle-normalize');
const { fillableNames } = require('./lib/sim-plant-population');
const TOKEN = process.env.TREFLE_TOKEN;
const BASE = 'https://trefle.io/api/v1';
const CACHE = path.join(__dirname, 'trefle-sim-cache');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status === 429) { await sleep(3000); continue; } if (r.ok) return await r.json(); } catch (_) {}
    await sleep(800);
  }
  return null;
}
async function main() {
  if (!TOKEN) { console.error('TREFLE_TOKEN missing in .env'); process.exit(1); }
  const args = process.argv.slice(2);
  const limit = (args.find((a) => a.startsWith('--limit=')) || '').split('=')[1];
  const refresh = args.includes('--refresh');
  fs.mkdirSync(CACHE, { recursive: true });
  const db = new Database(CORPUS_DB, { readonly: true });
  let names = fillableNames(db); db.close();
  if (limit) names = names.slice(0, parseInt(limit, 10));
  let matched = 0, missed = 0, cachedSkip = 0, withHabit = 0;
  for (const name of names) {
    const file = path.join(CACHE, slug(name) + '.json');
    if (!refresh && fs.existsSync(file)) { cachedSkip++; continue; }
    const s = await getJSON(`${BASE}/species/search?q=${encodeURIComponent(name)}&token=${TOKEN}`); await sleep(300);
    const hit = matchSpecies(s && s.data, name);
    let out = { query_name: name, matched: null };
    if (hit) {
      const d = await getJSON(`${BASE}/species/${hit.id}?token=${TOKEN}`); await sleep(300);
      out.matched = (d && d.data) || null;
      if (out.matched) { matched++; if ((out.matched.specifications || {}).growth_habit) withHabit++; } else missed++;
    } else missed++;
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
  }
  console.log(`[fetch-trefle] names=${names.length} cachedSkip=${cachedSkip} matched=${matched} missed=${missed} withHabit=${withHabit} | cache: ${CACHE}`);
}
if (require.main === module) main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
