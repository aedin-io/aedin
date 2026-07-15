/**
 * build-atlas-data — emits the two static JSON payloads that the /atlas
 * client island consumes:
 *
 *   dist/data/atlas.json            — all entities + edges from ai_reviewed
 *                                     claims, stripped to graph-essential
 *                                     fields. Loaded once on /atlas mount;
 *                                     filtering happens browser-side.
 *
 *   dist/data/atlas-highlights.json — curated ~50-edge seed graph shown
 *                                     before the user applies any filter.
 *                                     Breadth-illustrative (3 entities per
 *                                     agroeco_bucket × top-2 edges + 8
 *                                     cross-bucket surprises).
 *
 * Run after `astro build` so dist/ exists. Failing to write either file
 * fails the build:verify guard in web/package.json.
 *
 * ESM module — web/package.json has "type": "module".
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { normalizeRegion } from './region-normalize.js';
import { CANONICAL_SCOPES } from '../src/lib/region-scopes.js';

const require = createRequire(import.meta.url);
const { effectiveTags, priorityTier } = require('../../backend/lib/agronomic-uses');
const { resolveBuildDbPath } = require('./lib/resolve-build-db.cjs');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = resolveBuildDbPath();
const DIST_DATA_DIR = path.join(__dirname, '..', 'dist', 'data');

function build() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[build-atlas-data] DB not found at ${DB_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(__dirname, '..', 'dist'))) {
    console.error('[build-atlas-data] dist/ missing — run `astro build` first');
    process.exit(1);
  }
  fs.mkdirSync(DIST_DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH, { readonly: true });

  const entities = db.prepare(`
    WITH participants AS (
      SELECT subject_entity_id AS id FROM claims WHERE review_status='ai_reviewed'
      UNION
      SELECT object_entity_id AS id FROM claims WHERE review_status='ai_reviewed' AND object_entity_id IS NOT NULL
    ),
    counts AS (
      SELECT id, COUNT(*) AS n FROM (
        SELECT subject_entity_id AS id FROM claims WHERE review_status='ai_reviewed'
        UNION ALL
        SELECT object_entity_id AS id FROM claims WHERE review_status='ai_reviewed' AND object_entity_id IS NOT NULL
      ) GROUP BY id
    )
    SELECT
      e.id, e.slug, e.scientific_name, e.common_name, e.family,
      e.bio_category, e.agroeco_bucket, e.primary_role,
      e.taxonomy_path, e.agronomic_uses,
      COALESCE(c.n, 0) AS claim_count
    FROM entities e
    JOIN participants p ON p.id = e.id
    LEFT JOIN counts c ON c.id = e.id
    WHERE e.slug IS NOT NULL
      AND e.merged_into_entity_id IS NULL
    ORDER BY claim_count DESC
  `).all().map(row => {
    // Parse agronomic_uses JSON; expose pre-computed effective tags so /crop-web
    // doesn't have to import the agronomic-uses lib client-side.
    let parsed = null;
    try { parsed = row.agronomic_uses ? JSON.parse(row.agronomic_uses) : null; }
    catch { parsed = null; }
    const eff = effectiveTags({ agronomic_uses: parsed, family: row.family });
    return {
      ...row,
      agronomic_uses: parsed,
      effective_uses: eff,
      crop_tier: priorityTier({ agronomic_uses: parsed, primary_role: row.primary_role, family: row.family }),
    };
  });

  // Restrict edges to claims where BOTH endpoints survive the entities
  // query (slug IS NOT NULL). Without this guard, atlas.json#edges can
  // reference entity IDs that aren't in atlas.json#entities — Sigma
  // silently dropped these, but Cytoscape (and any strict graph lib)
  // throws on addEdge with a missing endpoint.
  const entityIdSet = new Set(entities.map(e => e.id));
  const rawEdges = db.prepare(`
    SELECT
      id AS claim_id,
      subject_entity_id AS subject_id,
      object_entity_id  AS object_id,
      interaction_type_globi AS globi_term,
      interaction_category,
      regional_context  AS region
    FROM claims
    WHERE review_status='ai_reviewed'
      AND object_entity_id IS NOT NULL
      AND interaction_type_globi IS NOT NULL
  `).all().filter(e => entityIdSet.has(e.subject_id) && entityIdSet.has(e.object_id));

  // Enrich each edge with parsed { scope, country, subdivision } from the
  // free-text regional_context. Build a derived countries index for the
  // cascading region selector while we're at it.
  const countriesIndex = new Map();
  const scopeCounts = new Map();
  let unmatchedRegions = 0;
  const edges = rawEdges.map(e => {
    const norm = normalizeRegion(e.region);
    for (const s of norm.scopes) scopeCounts.set(s, (scopeCounts.get(s) || 0) + 1);
    if (norm.country) {
      if (!countriesIndex.has(norm.country)) {
        countriesIndex.set(norm.country, { name: norm.country, claim_count: 0, subdivisions: new Map() });
      }
      const ci = countriesIndex.get(norm.country);
      ci.claim_count++;
      if (norm.subdivision) {
        ci.subdivisions.set(norm.subdivision, (ci.subdivisions.get(norm.subdivision) || 0) + 1);
      }
    }
    if (e.region && !norm.scopes.length && !norm.country) unmatchedRegions++;
    return {
      ...e,
      scopes: norm.scopes,
      country: norm.country,
      subdivision: norm.subdivision,
    };
  });

  const countries = [...countriesIndex.values()]
    .map(c => ({
      name: c.name,
      claim_count: c.claim_count,
      subdivisions: [...c.subdivisions.entries()]
        .map(([name, n]) => ({ name, claim_count: n }))
        .sort((a, b) => b.claim_count - a.claim_count),
    }))
    .sort((a, b) => b.claim_count - a.claim_count);

  const scopes = CANONICAL_SCOPES
    .map(name => ({ name, claim_count: scopeCounts.get(name) || 0 }))
    .filter(s => s.claim_count > 0);

  console.log(`[build-atlas-data] region parse: ${countries.length} countries, ${scopes.length} scopes, ${unmatchedRegions} unmatched edges`);

  const distinctRegions = db.prepare(`
    SELECT regional_context AS region, COUNT(*) AS n
    FROM claims
    WHERE review_status='ai_reviewed' AND regional_context IS NOT NULL
    GROUP BY regional_context
    ORDER BY n DESC
  `).all();

  const distinctGlobi = db.prepare(`
    SELECT interaction_type_globi AS term, COUNT(*) AS n
    FROM claims
    WHERE review_status='ai_reviewed' AND interaction_type_globi IS NOT NULL
    GROUP BY interaction_type_globi
    ORDER BY n DESC
  `).all();

  const atlas = {
    generated_at: new Date().toISOString(),
    entity_count: entities.length,
    edge_count: edges.length,
    region_count: distinctRegions.length,
    globi_term_count: distinctGlobi.length,
    country_count: countries.length,
    scope_count: scopes.length,
    regions: distinctRegions,
    globi_terms: distinctGlobi,
    countries,
    scopes,
    entities,
    edges,
  };
  fs.writeFileSync(path.join(DIST_DATA_DIR, 'atlas.json'), JSON.stringify(atlas));
  const sizeMB = (fs.statSync(path.join(DIST_DATA_DIR, 'atlas.json')).size / 1024 / 1024).toFixed(2);
  console.log(`[build-atlas-data] atlas.json — ${entities.length} entities, ${edges.length} edges, ${sizeMB} MB`);

  const highlightEdges = pickHighlights(entities, edges);
  const highlightNodeIds = new Set();
  for (const e of highlightEdges) {
    highlightNodeIds.add(e.subject_id);
    highlightNodeIds.add(e.object_id);
  }
  const highlightNodes = entities.filter(e => highlightNodeIds.has(e.id));
  const highlights = {
    generated_at: atlas.generated_at,
    entity_count: highlightNodes.length,
    edge_count: highlightEdges.length,
    entities: highlightNodes,
    edges: highlightEdges,
  };
  fs.writeFileSync(path.join(DIST_DATA_DIR, 'atlas-highlights.json'), JSON.stringify(highlights));
  console.log(`[build-atlas-data] atlas-highlights.json — ${highlightNodes.length} nodes, ${highlightEdges.length} edges`);

  db.close();
}

function pickHighlights(entities, edges) {
  const byBucket = new Map();
  for (const e of entities) {
    if (!e.agroeco_bucket) continue;
    if (!byBucket.has(e.agroeco_bucket)) byBucket.set(e.agroeco_bucket, []);
    byBucket.get(e.agroeco_bucket).push(e);
  }
  const seedIds = new Set();
  for (const [, list] of byBucket) {
    for (const e of list.slice(0, 3)) seedIds.add(e.id);
  }

  const edgeKey = e => `${e.subject_id}|${e.object_id}|${e.globi_term}`;
  const edgeFreq = new Map();
  for (const e of edges) {
    edgeFreq.set(edgeKey(e), (edgeFreq.get(edgeKey(e)) || 0) + 1);
  }

  const picked = [];
  const pickedKeys = new Set();
  const entityById = new Map(entities.map(e => [e.id, e]));

  for (const seed of seedIds) {
    const candidates = edges
      .filter(e => e.subject_id === seed || e.object_id === seed)
      .sort((a, b) => (edgeFreq.get(edgeKey(b)) || 0) - (edgeFreq.get(edgeKey(a)) || 0));
    let added = 0;
    for (const c of candidates) {
      if (added >= 2) break;
      const k = edgeKey(c);
      if (pickedKeys.has(k)) continue;
      picked.push(c);
      pickedKeys.add(k);
      added++;
    }
  }

  const crossBucketEdges = edges
    .filter(e => {
      const s = entityById.get(e.subject_id);
      const o = entityById.get(e.object_id);
      if (!s || !o) return false;
      if (!s.agroeco_bucket || !o.agroeco_bucket) return false;
      if (s.agroeco_bucket === o.agroeco_bucket) return false;
      const isHerbPred = (s.agroeco_bucket === 'producer' && o.agroeco_bucket === 'herbivore')
                      || (s.agroeco_bucket === 'herbivore' && o.agroeco_bucket === 'producer');
      return !isHerbPred;
    })
    .sort((a, b) => (edgeFreq.get(edgeKey(b)) || 0) - (edgeFreq.get(edgeKey(a)) || 0));

  for (const c of crossBucketEdges) {
    if (picked.length >= 50) break;
    const k = edgeKey(c);
    if (pickedKeys.has(k)) continue;
    picked.push(c);
    pickedKeys.add(k);
  }

  return picked.slice(0, 50);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) build();

export { build };
