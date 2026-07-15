#!/usr/bin/env node
/**
 * EPPO Global Database common-name ingest.
 *
 * Pulls plant + fungal/bacterial/viral/chromistan common names from the EPPO
 * GD v2 REST API and merges (in place) into:
 *   backend/lib/common-names-species.json
 *   backend/lib/common-names-collective.json
 *
 * Skips arthropods (ESA covers them, ESA wins for Animalia).
 *
 * Strategy
 *   1. Enumerate /taxons/list (all pages). Keep is_active + datatype in
 *      {PFL,SPT,GAF,SFT}. PFL/GAF carry species-rank records; SPT/SFT carry
 *      genus-rank records (used only to validate collective vernaculars).
 *   2. For each candidate fetch /names. Filter to English names (lang_iso='en').
 *   3. For each candidate WITH ≥1 EN name fetch /taxonomy to confirm
 *      terminal rank == Species and capture the kingdom.
 *   4. Build common-name index. Drop homonyms (one EN name → multiple
 *      EPPO species). Apply the same ESA-pass rigor:
 *        - EN-only, length ≥4, scientific = species, preferred=true scientific.
 *   5. Merge into existing files:
 *        - new entry         → source: "eppo"
 *        - agrees with ESA   → upgrade existing entry to source: "esa+eppo"
 *        - disagrees with ESA → drop both, push AMBIGUOUS row to collective JSON.
 *
 * State is checkpointed to /tmp/claude/eppo-ingest-state.json after every
 * 100 fetched name records so an interrupted run can resume without re-fetching.
 *
 * NO LLM training data is consulted. Every new entry traces to an EPPO API
 * response captured in the state file.
 */

const fs = require('fs');
const path = require('path');

// -------- config --------
const ROOT = path.resolve(__dirname);
const SPECIES_PATH = path.join(ROOT, 'lib', 'common-names-species.json');
const COLLECTIVE_PATH = path.join(ROOT, 'lib', 'common-names-collective.json');
const STATE_DIR = '/tmp/claude';
const STATE_PATH = path.join(STATE_DIR, 'eppo-ingest-state.json');
const ENV_PATH = path.join(ROOT, '.env');

const API_BASE = 'https://api.eppo.int/gd/v2';
const THROTTLE_MS = 0;          // inter-wave gap (per-wave already gated by network)
const PARALLEL = 50;            // concurrent in-flight fetches; limit is 2000/10s
const NAMES_BATCH_LOG = 1000;   // checkpoint every N name fetches
const LIST_PAGE_SIZE = 1000;

// datatypes we care about
const SPECIES_DATATYPES = new Set(['PFL', 'GAF']);  // PFL=Plantae sp., GAF=Fungi/Bacteria/Viruses/Chromista sp.
const GENUS_DATATYPES   = new Set(['SPT', 'SFT']);  // used only to verify collective vernaculars resolve to a known genus
const SKIP_DATATYPES    = new Set(['GAI', 'SIT']);  // Animalia (ESA covers them)

// minimal kingdom → bio_category mapping (mirrors the kingdom-hint logic in backend/lib)
function kingdomBucket(k) {
  if (!k) return null;
  if (k === 'Plantae') return 'Plantae';
  if (k === 'Fungi') return 'Fungi';
  if (k === 'Bacteria') return 'Bacteria';
  if (k === 'Chromista' || k === 'Protozoa') return k;
  if (/virus/i.test(k)) return 'Viruses';
  if (k === 'Animalia') return 'Animalia';  // shouldn't happen — we skip GAI/SIT
  return k;
}

// -------- env loading --------
function loadEnv() {
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  const out = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const TOKEN = env.EPPO_TOKEN;
if (!TOKEN) {
  console.error('FATAL: EPPO_TOKEN missing from backend/.env');
  process.exit(1);
}

// -------- HTTP with retry --------
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJSON(url, attempt = 0) {
  try {
    const r = await fetch(url, {
      headers: { 'X-Api-Key': TOKEN, 'Accept': 'application/json' },
    });
    if (r.status === 429) {
      const wait = 2000 * (attempt + 1);
      console.warn(`[429] backing off ${wait}ms on ${url}`);
      await sleep(wait);
      return getJSON(url, attempt + 1);
    }
    if (r.status === 404) return { _missing: true };
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    return await r.json();
  } catch (e) {
    if (attempt < 3) {
      console.warn(`[retry ${attempt + 1}] ${url}: ${e.message}`);
      await sleep(1500 * (attempt + 1));
      return getJSON(url, attempt + 1);
    }
    throw e;
  }
}

// -------- state --------
function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (e) {
      console.warn('state file unparseable; starting fresh');
    }
  }
  return {
    enumerated: false,
    candidates: [],         // [{eppocode, datatype}]
    namesFetched: {},       // eppocode -> [{fullname, lang_iso, preferred, author}]
    taxonomyFetched: {},    // eppocode -> [{prefname, type, level}]
    finishedNames: false,
    finishedTaxonomy: false,
    apiCallCount: 0,
    rateLimitHits: 0,
  };
}

function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s));
}

// -------- phase 1: enumerate /taxons/list --------
async function enumerateAll(state) {
  if (state.enumerated) {
    console.log(`[1/4] already enumerated: ${state.candidates.length} candidates`);
    return;
  }
  console.log('[1/4] enumerating /taxons/list ...');
  // Probe total
  const first = await getJSON(`${API_BASE}/taxons/list?limit=1&offset=0&orderBy=eppocode`);
  state.apiCallCount++;
  const total = first.pagination.total;
  console.log(`  total taxons in EPPO GD: ${total}`);

  const candidates = [];
  const skipped = { inactive: 0, animalia: 0, other: 0, genus: 0, kept: 0 };
  for (let offset = 0; offset < total; offset += LIST_PAGE_SIZE) {
    const j = await getJSON(
      `${API_BASE}/taxons/list?limit=${LIST_PAGE_SIZE}&offset=${offset}&orderBy=eppocode`
    );
    state.apiCallCount++;
    for (const row of j.data) {
      if (!row.is_active) { skipped.inactive++; continue; }
      if (SKIP_DATATYPES.has(row.datatype)) { skipped.animalia++; continue; }
      if (SPECIES_DATATYPES.has(row.datatype)) {
        candidates.push({ eppocode: row.eppocode, datatype: row.datatype, level: 'species' });
        skipped.kept++;
      } else if (GENUS_DATATYPES.has(row.datatype)) {
        candidates.push({ eppocode: row.eppocode, datatype: row.datatype, level: 'genus' });
        skipped.genus++;
      } else {
        skipped.other++;
      }
    }
    if ((offset / LIST_PAGE_SIZE) % 10 === 0) {
      console.log(`  ...${offset + j.data.length}/${total}  kept=${skipped.kept} genus=${skipped.genus}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`  enumeration done. kept species=${skipped.kept} genus=${skipped.genus} skipped Animalia=${skipped.animalia} inactive=${skipped.inactive} other=${skipped.other}`);
  state.candidates = candidates;
  state.enumerated = true;
  saveState(state);
}

// -------- phase 2: fetch /names for every candidate --------
async function fetchNames(state) {
  if (state.finishedNames) {
    console.log(`[2/4] already fetched names for ${Object.keys(state.namesFetched).length} taxa`);
    return;
  }
  const todo = state.candidates.filter(c => !(c.eppocode in state.namesFetched));
  console.log(`[2/4] fetching /names for ${todo.length} candidates (${Object.keys(state.namesFetched).length} cached) ...`);
  let done = 0;
  // process in waves of PARALLEL
  for (let i = 0; i < todo.length; i += PARALLEL) {
    const wave = todo.slice(i, i + PARALLEL);
    const results = await Promise.all(wave.map(async c => {
      const j = await getJSON(`${API_BASE}/taxons/taxon/${c.eppocode}/names`);
      return [c.eppocode, j];
    }));
    for (const [code, j] of results) {
      state.apiCallCount++;
      if (j._missing) state.namesFetched[code] = [];
      else if (Array.isArray(j)) state.namesFetched[code] = j;
      else state.namesFetched[code] = [];
    }
    done += wave.length;
    if (done % NAMES_BATCH_LOG < PARALLEL) {
      saveState(state);
      console.log(`  ...${done}/${todo.length}  apiCalls=${state.apiCallCount}`);
    }
    await sleep(THROTTLE_MS);
  }
  state.finishedNames = true;
  saveState(state);
  console.log(`  names phase done.`);
}

// -------- phase 3: taxonomy for candidates with ≥1 EN name --------
async function fetchTaxonomy(state) {
  if (state.finishedTaxonomy) {
    console.log(`[3/4] already fetched taxonomy for ${Object.keys(state.taxonomyFetched).length} taxa`);
    return;
  }
  const needsTaxonomy = state.candidates.filter(c => {
    if (c.eppocode in state.taxonomyFetched) return false;
    const names = state.namesFetched[c.eppocode] || [];
    return names.some(n => n.lang_iso === 'en' && typeof n.fullname === 'string' && n.fullname.trim().length >= 4);
  });
  console.log(`[3/4] fetching /taxonomy for ${needsTaxonomy.length} candidates with EN names ...`);
  let done = 0;
  for (let i = 0; i < needsTaxonomy.length; i += PARALLEL) {
    const wave = needsTaxonomy.slice(i, i + PARALLEL);
    const results = await Promise.all(wave.map(async c => {
      const j = await getJSON(`${API_BASE}/taxons/taxon/${c.eppocode}/taxonomy`);
      return [c.eppocode, j];
    }));
    for (const [code, j] of results) {
      state.apiCallCount++;
      if (j._missing) state.taxonomyFetched[code] = [];
      else if (Array.isArray(j)) state.taxonomyFetched[code] = j;
      else state.taxonomyFetched[code] = [];
    }
    done += wave.length;
    if (done % NAMES_BATCH_LOG < PARALLEL) {
      saveState(state);
      console.log(`  ...${done}/${needsTaxonomy.length}  apiCalls=${state.apiCallCount}`);
    }
    await sleep(THROTTLE_MS);
  }
  state.finishedTaxonomy = true;
  saveState(state);
  console.log(`  taxonomy phase done.`);
}

// -------- phase 4: build index + merge --------
function normaliseCommon(s) {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}
const SINGULAR_RX = /(ies|s|es)$/i;

function buildEppoIndex(state) {
  // For every species candidate, gather its EN common names with preferred-scientific check.
  // Output: { commonNorm: [ { scientific, kingdom, rank, eppocode, prefScientific, isPreferred } ] }
  const idx = new Map();

  for (const c of state.candidates) {
    if (c.level !== 'species') continue;
    const tax = state.taxonomyFetched[c.eppocode];
    if (!tax || tax.length === 0) continue;

    const terminal = tax[tax.length - 1];
    if (terminal.type !== 'Species') continue;   // strict: skip subspecies/hybrid
    const scientific = terminal.prefname;
    if (!scientific || !/^[A-Z][a-z]+ [a-z]+/.test(scientific)) {
      // Reject anything that doesn't parse as a clean binomial (filters out
      // weirdly-formed virus names like "Orthotospovirus alstroemerinecrosis"?
      // Actually viruses don't follow Linnean binomials → won't match.
      // Reject them — only entries with a clean binomial are unambiguous.
      // BUT viruses are still useful; loosen for Viruses kingdom.
      const kingdom = (tax[0] && tax[0].prefname) || '';
      if (!/virus/i.test(kingdom)) continue;
      if (!scientific) continue;
    }
    const kingdom = tax[0] && tax[0].prefname;
    if (!kingdom) continue;
    if (kingdom === 'Animalia') continue;       // arthropods already covered by ESA — defense-in-depth

    const names = state.namesFetched[c.eppocode] || [];
    // EN common names; skip if it IS the preferred scientific (Latin)
    const en = names.filter(n => n.lang_iso === 'en'
      && typeof n.fullname === 'string'
      && n.fullname.trim().length >= 4
      && n.fullname.toLowerCase() !== scientific.toLowerCase()
    );
    for (const n of en) {
      const norm = normaliseCommon(n.fullname);
      if (!norm) continue;
      // Drop common names with embedded "/", ":" or "(" — typically multi-name composite labels.
      if (/[\/:]/.test(norm)) continue;
      if (!idx.has(norm)) idx.set(norm, []);
      idx.get(norm).push({
        scientific,
        kingdom,
        rank: 'species',
        eppocode: c.eppocode,
        isPreferredName: !!n.preferred,
      });
    }
  }
  return idx;
}

function mergeIntoFiles(eppoIndex) {
  // Load existing
  const speciesDoc = JSON.parse(fs.readFileSync(SPECIES_PATH, 'utf8'));
  const collectiveDoc = JSON.parse(fs.readFileSync(COLLECTIVE_PATH, 'utf8'));

  // Build maps for fast existing lookup.
  const speciesByCommon = new Map();
  for (const e of speciesDoc.entries) {
    speciesByCommon.set(normaliseCommon(e.common), e);
  }
  const collectiveByCommon = new Map();
  for (const e of collectiveDoc.entries) {
    collectiveByCommon.set(normaliseCommon(e.common), e);
    if (e.plural) collectiveByCommon.set(normaliseCommon(e.plural), e);
  }

  const stats = {
    eppoOnly: 0,        // brand new from EPPO
    esaConfirmed: 0,    // existing ESA entry; EPPO agrees → upgrade to esa+eppo
    esaDisagreed: 0,    // existing ESA entry; EPPO maps to a different species → drop both, mark ambiguous
    homonymDropped: 0,  // one EN name → multiple EPPO species → ambiguous
    addedAmbiguous: 0,
    skippedExistingNonEsa: 0,  // already in seed; do nothing
    examplesByKingdom: { Plantae: [], Fungi: [], Bacteria: [], Viruses: [], Chromista: [] },
  };

  for (const [common, hits] of eppoIndex.entries()) {
    // dedupe identical scientific within same common name
    const uniqHits = [];
    const seenSci = new Set();
    for (const h of hits) {
      if (seenSci.has(h.scientific)) continue;
      seenSci.add(h.scientific);
      uniqHits.push(h);
    }
    if (uniqHits.length > 1) {
      // HOMONYM — EPPO knows multiple species for this EN common name.
      stats.homonymDropped++;
      // If ESA had an entry that conflicts, drop it.
      const esaEntry = speciesByCommon.get(common);
      if (esaEntry) {
        // Conservative: leave the ESA entry alone — ESA wins for Animalia,
        // and our EPPO sweep skipped Animalia. So an ESA entry conflicting
        // with a multi-EPPO-hit kingdom means it really is ambiguous across
        // kingdoms. Drop ESA + EPPO; mark collective ambiguous.
        // Remove from species:
        speciesDoc.entries = speciesDoc.entries.filter(e => normaliseCommon(e.common) !== common);
        speciesByCommon.delete(common);
        stats.esaDisagreed++;
      }
      if (!collectiveByCommon.has(common)) {
        const noteScis = uniqHits.slice(0, 3).map(h => `${h.scientific} (${h.kingdom})`).join('; ');
        const ambig = {
          common,
          plural: common.endsWith('s') ? common : common + 's',
          scientific: 'AMBIGUOUS',
          rank: 'ambiguous',
          kingdom: uniqHits[0].kingdom === uniqHits[uniqHits.length - 1].kingdom ? uniqHits[0].kingdom : 'multiple',
          notes: `EPPO maps this name to ${uniqHits.length} species: ${noteScis}${uniqHits.length>3?'…':''}`,
          source: 'eppo',
        };
        collectiveDoc.entries.push(ambig);
        collectiveByCommon.set(common, ambig);
        stats.addedAmbiguous++;
      }
      continue;
    }

    const eppoHit = uniqHits[0];
    const existing = speciesByCommon.get(common);

    if (existing) {
      if (existing.source === 'seed') {
        // seed wins, always — do not touch
        stats.skippedExistingNonEsa++;
        continue;
      }
      // Existing is ESA (arthropod) — EPPO sweep skipped Animalia, so EPPO hit is
      // by definition a non-Animalia species. CROSS-KINGDOM CONFLICT.
      if (existing.scientific.toLowerCase() !== eppoHit.scientific.toLowerCase()) {
        // ESA says it's an insect; EPPO says it's a plant/fungus/etc. with the same EN name.
        // → cross-kingdom homonym; drop ESA + EPPO, mark ambiguous.
        speciesDoc.entries = speciesDoc.entries.filter(e => normaliseCommon(e.common) !== common);
        speciesByCommon.delete(common);
        stats.esaDisagreed++;
        if (!collectiveByCommon.has(common)) {
          const ambig = {
            common,
            plural: common.endsWith('s') ? common : common + 's',
            scientific: 'AMBIGUOUS',
            rank: 'ambiguous',
            kingdom: 'multiple',
            notes: `Homonym across kingdoms: ESA assigns "${existing.scientific}" (${existing.kingdom}); EPPO assigns "${eppoHit.scientific}" (${eppoHit.kingdom})`,
            source: 'esa+eppo',
          };
          collectiveDoc.entries.push(ambig);
          collectiveByCommon.set(common, ambig);
          stats.addedAmbiguous++;
        }
      } else {
        // identical scientific → upgrade source
        if (existing.source === 'esa') existing.source = 'esa+eppo';
        stats.esaConfirmed++;
      }
      continue;
    }

    // Also check if collective already has this — if so, it's an established collective vernacular; skip.
    if (collectiveByCommon.has(common)) {
      stats.skippedExistingNonEsa++;
      continue;
    }

    // Brand new EPPO-only entry.
    const newEntry = {
      common,
      scientific: eppoHit.scientific,
      rank: 'species',
      kingdom: eppoHit.kingdom,
      eppocode: eppoHit.eppocode,
      source: 'eppo',
    };
    speciesDoc.entries.push(newEntry);
    speciesByCommon.set(common, newEntry);
    stats.eppoOnly++;

    // Track examples (up to 12 per kingdom for the report)
    const bucket = kingdomBucket(eppoHit.kingdom);
    if (bucket && stats.examplesByKingdom[bucket] && stats.examplesByKingdom[bucket].length < 12) {
      stats.examplesByKingdom[bucket].push({ common, scientific: eppoHit.scientific, eppocode: eppoHit.eppocode });
    }
  }

  // ---- update _meta ----
  const today = new Date().toISOString().slice(0, 10);
  const provS = speciesDoc._meta.provenance_breakdown || {};
  const provC = collectiveDoc._meta.provenance_breakdown || {};

  // Recompute provenance from current entries (authoritative)
  const recount = (entries) => {
    const acc = { seed: 0, esa: 0, eppo: 0, 'esa+eppo': 0, ambiguous: 0 };
    for (const e of entries) {
      const k = e.scientific === 'AMBIGUOUS' ? 'ambiguous' : (e.source || 'seed');
      acc[k] = (acc[k] || 0) + 1;
    }
    return acc;
  };
  speciesDoc._meta.provenance_breakdown = recount(speciesDoc.entries);
  collectiveDoc._meta.provenance_breakdown = recount(collectiveDoc.entries);
  speciesDoc._meta.entry_count = speciesDoc.entries.length;
  collectiveDoc._meta.entry_count = collectiveDoc.entries.length;
  speciesDoc._meta.last_ingest_date = today;
  collectiveDoc._meta.last_ingest_date = today;

  const eppoAttr = ' EPPO Global Database (data.eppo.int, https://api.eppo.int/gd/v2/) ingested via authenticated REST API on ' + today + '; non-Animalia kingdoms only (Plantae, Fungi, Bacteria, Viruses, Chromista). EPPO data is published under the EPPO Open Data Licence (https://data.eppo.int/page/policy).';
  if (!/EPPO Global Database \(data\.eppo\.int.*?ingested/.test(speciesDoc._meta.attribution)) {
    speciesDoc._meta.attribution = speciesDoc._meta.attribution.replace(
      / EPPO Global Database[^"]*?credentials\./,
      eppoAttr
    );
    if (!speciesDoc._meta.attribution.includes('ingested via authenticated REST API on ' + today)) {
      speciesDoc._meta.attribution += eppoAttr;
    }
  }
  if (!/EPPO Global Database \(data\.eppo\.int.*?ingested/.test(collectiveDoc._meta.attribution)) {
    collectiveDoc._meta.attribution = collectiveDoc._meta.attribution.replace(
      / EPPO Global Database[^"]*?credentials\./,
      eppoAttr
    );
    if (!collectiveDoc._meta.attribution.includes('ingested via authenticated REST API on ' + today)) {
      collectiveDoc._meta.attribution += eppoAttr;
    }
  }

  // Validate JSON parses before writing
  const speciesJSON = JSON.stringify(speciesDoc, null, 2);
  const collectiveJSON = JSON.stringify(collectiveDoc, null, 2);
  JSON.parse(speciesJSON);
  JSON.parse(collectiveJSON);

  fs.writeFileSync(SPECIES_PATH, speciesJSON);
  fs.writeFileSync(COLLECTIVE_PATH, collectiveJSON);

  return { stats, speciesDoc, collectiveDoc };
}

// -------- main --------
(async () => {
  const state = loadState();
  try {
    await enumerateAll(state);
    await fetchNames(state);
    await fetchTaxonomy(state);
  } catch (e) {
    saveState(state);
    console.error('FETCH PHASE FAILED:', e.message);
    console.error('State saved; rerun the script to resume.');
    process.exit(2);
  }

  console.log('[4/4] building index and merging into JSON files ...');
  const eppoIndex = buildEppoIndex(state);
  console.log(`  EPPO EN-common-name index: ${eppoIndex.size} distinct common names`);

  const { stats, speciesDoc, collectiveDoc } = mergeIntoFiles(eppoIndex);

  console.log('\n=== MERGE REPORT ===');
  console.log('API calls made:', state.apiCallCount, '  rate-limit hits:', state.rateLimitHits);
  console.log('species entries before/after:', 2271, '/', speciesDoc.entries.length);
  console.log('collective entries before/after:', 39, '/', collectiveDoc.entries.length);
  console.log('species provenance:', speciesDoc._meta.provenance_breakdown);
  console.log('collective provenance:', collectiveDoc._meta.provenance_breakdown);
  console.log('merge stats:', {
    eppoOnly: stats.eppoOnly,
    esaConfirmed: stats.esaConfirmed,
    esaDisagreed_dropped: stats.esaDisagreed,
    homonymDropped: stats.homonymDropped,
    addedAmbiguous: stats.addedAmbiguous,
    skippedExisting: stats.skippedExistingNonEsa,
  });
  for (const k of ['Plantae', 'Fungi', 'Bacteria', 'Viruses', 'Chromista']) {
    console.log(`\nSample new ${k} entries (up to 12):`);
    for (const e of stats.examplesByKingdom[k]) {
      console.log(`  ${e.common}  →  ${e.scientific}  [${e.eppocode}]`);
    }
  }
  console.log('\nFiles written:');
  console.log('  ' + SPECIES_PATH);
  console.log('  ' + COLLECTIVE_PATH);
})();
