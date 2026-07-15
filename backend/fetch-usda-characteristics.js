#!/usr/bin/env node
'use strict';
/** fetch-usda-characteristics.js — run-once idempotent cacher of USDA PLANTS characteristics for the
 *  sim plant population. name → accepted taxon (verified binomial) → characteristics → usda-cache/.
 *  Public-domain data, used only as un-surfaced sim input. Usage: [--limit=N] [--refresh]. */
const fs = require('fs'); const path = require('path');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { matchAccepted } = require('./lib/usda-normalize');
const { fillableNames } = require('./lib/sim-plant-population');
const BASE = 'https://plantsservices.sc.egov.usda.gov/api';
const CACHE = path.join(__dirname, 'usda-cache');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
async function getJSON(url, tries = 2) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (_) {} await sleep(600); }
  return null;
}
async function main() {
  const args = process.argv.slice(2);
  const limit = (args.find((a) => a.startsWith('--limit=')) || '').split('=')[1];
  const refresh = args.includes('--refresh');
  fs.mkdirSync(CACHE, { recursive: true });
  const db = new Database(CORPUS_DB, { readonly: true });
  let names = fillableNames(db); db.close();
  if (limit) names = names.slice(0, parseInt(limit, 10));
  let matched = 0, missed = 0, withHeight = 0, withRoot = 0, cachedSkip = 0;
  for (const name of names) {
    const file = path.join(CACHE, slug(name) + '.json');
    if (!refresh && fs.existsSync(file)) { cachedSkip++; continue; }
    const rows = await getJSON(`${BASE}/PlantSearch?searchText=${encodeURIComponent(name)}`); await sleep(250);
    const m = matchAccepted(rows, name);
    let out = { query_name: name, matched: null, characteristics: [] };
    if (m) {
      // Durations/GrowthHabits are NULL on search results — only PlantProfile (by symbol) carries them.
      const prof = await getJSON(`${BASE}/PlantProfile?symbol=${encodeURIComponent(m.Symbol)}`); await sleep(250);
      const chars = await getJSON(`${BASE}/PlantCharacteristics/${m.Id}`); await sleep(250);
      out = { query_name: name,
        matched: { Id: m.Id, Symbol: m.Symbol, AcceptedScientificName: (m.AcceptedScientificName || m.ScientificName || '').replace(/<[^>]+>/g, ''), Durations: (prof && prof.Durations) || [], GrowthHabits: (prof && prof.GrowthHabits) || [] },
        characteristics: Array.isArray(chars) ? chars : [] };
      matched++;
      if (out.characteristics.some((c) => c.PlantCharacteristicName === 'Height, Mature (feet)' && c.PlantCharacteristicValue)) withHeight++;
      if (out.characteristics.some((c) => c.PlantCharacteristicName === 'Root Depth, Minimum (inches)' && c.PlantCharacteristicValue)) withRoot++;
    } else { missed++; }
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
  }
  console.log(`[fetch-usda] names=${names.length} cachedSkip=${cachedSkip} matched=${matched} missed=${missed} withHeight=${withHeight} withRoot=${withRoot} | cache: ${CACHE}`);
}
if (require.main === module) main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
