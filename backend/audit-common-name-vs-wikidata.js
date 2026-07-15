#!/usr/bin/env node
/**
 * audit-common-name-vs-wikidata.js
 *
 * Read-only audit. For a sample of entities, re-fetches the canonical English
 * common name from Wikidata (taxon name = P225, common name = P1843@en) and
 * logs the diff against `entities.common_name`. Does NOT modify the DB.
 *
 * Implements the literal Phase-1 spec for bug #5:
 *   "Audit script that re-fetches from EPPO/Wikidata and logs diffs vs. current
 *    entities.common_name."
 *
 * Wikidata is preferred over EPPO because (a) it's CC0 / commercial-friendly,
 * (b) it has an open SPARQL endpoint, and (c) no API token is required.
 *
 * Output classes (per entity):
 *   match            — current and Wikidata agree (case-insensitive)
 *   substring        — one is a substring of the other (e.g. "honey bee" ⊂ "common honey bee")
 *   diff             — both have values but differ meaningfully
 *   missing_wikidata — current has a name, Wikidata has none
 *   missing_current  — Wikidata has a name, current is NULL
 *   no_taxon_match   — Wikidata has no item with P225 = scientific_name
 *
 * Usage:
 *   node audit-common-name-vs-wikidata.js                          # 100 random plantae
 *   node audit-common-name-vs-wikidata.js --limit=200
 *   node audit-common-name-vs-wikidata.js --bio=invertebrate
 *   node audit-common-name-vs-wikidata.js --role=crop --limit=300
 *   node audit-common-name-vs-wikidata.js --diff-only             # show only rows that differ
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 2000;

const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find(s => s.startsWith(`--${name}=`));
  if (!a) return args.includes(`--${name}`) ? true : def;
  return a.split('=', 2)[1];
}
const LIMIT = parseInt(flag('limit', '100'), 10);
const BIO = flag('bio', 'plantae');
const ROLE = flag('role', null);
const DIFF_ONLY = flag('diff-only', false) === true;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sparqlQuery(query) {
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AgroEco-Explorer/1.0 (audit-common-name-vs-wikidata; contact@agroeco.org)' }
  });
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function batchLookup(names) {
  const values = names.map(n => `"${n.replace(/"/g, '\\"')}"`).join(' ');
  const query = `
    SELECT ?name ?commonName WHERE {
      VALUES ?name { ${values} }
      ?item wdt:P225 ?name .
      OPTIONAL { ?item wdt:P1843 ?commonName . FILTER(LANG(?commonName) = "en") }
    }
  `;
  const data = await sparqlQuery(query);
  const out = {};
  for (const b of (data.results?.bindings || [])) {
    const name = b.name?.value;
    if (!name) continue;
    if (!out[name]) out[name] = { wikidata_common_names: [] };
    if (b.commonName?.value && !out[name].wikidata_common_names.includes(b.commonName.value)) {
      out[name].wikidata_common_names.push(b.commonName.value);
    }
  }
  return out;
}

function classify(currentCN, wikidataNames) {
  const cur = (currentCN || '').trim();
  const wikidataCanon = wikidataNames[0] || null;  // first English label

  if (!cur && wikidataNames.length === 0) return { kind: 'no_taxon_match' };
  if (!cur && wikidataNames.length > 0) return { kind: 'missing_current', suggested: wikidataCanon };
  if (cur && wikidataNames.length === 0) return { kind: 'missing_wikidata' };

  // Both have values — compare
  const curLow = cur.toLowerCase();
  const matches = wikidataNames.find(w => w.toLowerCase() === curLow);
  if (matches) return { kind: 'match' };

  // Substring match either way
  const subset = wikidataNames.find(w => curLow.includes(w.toLowerCase()) || w.toLowerCase().includes(curLow));
  if (subset) return { kind: 'substring', wikidata: subset };

  return { kind: 'diff', wikidata: wikidataCanon };
}

(async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Sample entities — random selection to avoid alphabetical bias
  let sql = `SELECT id, scientific_name, common_name, primary_role
             FROM entities WHERE bio_category = ? AND scientific_name IS NOT NULL`;
  const params = [BIO];
  if (ROLE) { sql += ` AND primary_role = ?`; params.push(ROLE); }
  sql += ` ORDER BY RANDOM() LIMIT ${LIMIT}`;

  const rows = await db.all(sql, params);
  console.log(`Sampled ${rows.length} entities (bio=${BIO}${ROLE ? `, role=${ROLE}` : ''})`);
  console.log(`Querying Wikidata in batches of ${BATCH_SIZE} (rate-limit ${RATE_LIMIT_MS}ms)...\n`);

  const wikidata = {};
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const names = slice.map(r => r.scientific_name);
    process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(rows.length / BATCH_SIZE)}... `);
    try {
      const result = await batchLookup(names);
      Object.assign(wikidata, result);
      console.log(`${Object.keys(result).length} matches`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
    if (i + BATCH_SIZE < rows.length) await sleep(RATE_LIMIT_MS);
  }

  // Classify each row
  const tally = { match: 0, substring: 0, diff: 0, missing_wikidata: 0, missing_current: 0, no_taxon_match: 0 };
  const samples = { diff: [], substring: [], missing_current: [] };

  for (const r of rows) {
    const wd = wikidata[r.scientific_name] || { wikidata_common_names: [] };
    const c = classify(r.common_name, wd.wikidata_common_names);
    tally[c.kind]++;
    if (samples[c.kind] && samples[c.kind].length < 8) {
      samples[c.kind].push({ id: r.id, sci: r.scientific_name, current: r.common_name, ...c });
    }
  }

  console.log(`\n=== audit summary (n=${rows.length}) ===`);
  for (const [k, v] of Object.entries(tally)) {
    const pct = (v / rows.length * 100).toFixed(1);
    console.log(`  ${k.padEnd(20)} ${v.toString().padStart(4)}  (${pct}%)`);
  }

  console.log('\n--- DIFF samples (current vs Wikidata, neither is substring of the other) ---');
  for (const s of samples.diff) {
    console.log(`  [${s.id}] ${s.sci}`);
    console.log(`    current:  "${s.current}"`);
    console.log(`    wikidata: "${s.wikidata}"`);
  }

  console.log('\n--- SUBSTRING samples (one contains the other — likely benign) ---');
  for (const s of samples.substring) {
    console.log(`  [${s.id}] ${s.sci}: current="${s.current}"  wikidata="${s.wikidata}"`);
  }

  console.log('\n--- MISSING_CURRENT samples (Wikidata has a name, our DB has none — backfill candidate) ---');
  for (const s of samples.missing_current) {
    console.log(`  [${s.id}] ${s.sci}: wikidata="${s.suggested}"`);
  }

  await db.close();
  console.log('\nDone. (Read-only audit; no DB modifications.)');
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
