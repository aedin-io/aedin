/**
 * AEDIN Backend - SQLite Only
 * Clean, simple API for crop exploration and planning
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// Prevent sqlite3 driver's unhandled error events from crashing the process
// (corrupt DB pages emit errors on Statement objects that bypass try/catch)
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('SQLITE_CORRUPT')) {
    console.warn('⚠ SQLite corruption error caught (non-fatal):', err.message);
  } else {
    console.error('Uncaught exception:', err);
    process.exit(1);
  }
});
const path         = require('path');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');
const migration007 = require('./migrations/007_extraction_pipeline');
const migration008 = require('./migrations/008_entities_table');
const migration009 = require('./migrations/009_claims_table');
const migration010 = require('./migrations/010_claim_regions');
const migration011 = require('./migrations/011_organism_fields');
const migration012 = require('./migrations/012_taxonomy_columns');
const migration013 = require('./migrations/013_variety_columns');
const migration014 = require('./migrations/014_role_agent');
const migration015 = require('./migrations/015_climate_grid');
const migration016 = require('./migrations/016_consolidate_entity_conditions');
const migration017 = require('./migrations/017_climate_grid_extended_soil');
const migration018 = require('./migrations/018_climate_grid_radiation_vapor_bedrock');
const migration019 = require('./migrations/019_score_raw_and_ceiling');
const migration020 = require('./migrations/020_soil_derived_fields');
const migration024 = require('./migrations/024_provenance_gating');
const migration025 = require('./migrations/025_claim_critic_verdicts');
const migration038 = require('./migrations/038_variety_dedup_reversibility');
const { extractSource } = require('./extract-source');
const { parseLatLon, buildSiteProfile } = require('./lib/site-profile');
const { getBioCategory } = require('./classify-taxon');
const { bioCategoryFromOrganismType, primaryRoleFromOrganismType } = require('./lib/organism-type');
const { isInheritable } = require('./lib/trait-inheritance');
const { computeCandidates, mergeVariety, unmergeVariety, keepSeparate } = require('./lib/merge-variety');
const { getReviewQueue, approveMerge, keepSeparate: keepSeparateEntity, getEntityLog } = require('./lib/entity-dedup-admin');
const { unmergeEntity } = require('./merge-entity');

// ── Phase 2 serving-layer review gate ─────────────────────────────────────────
// Restricts public endpoints to claims that have passed at least AI vouching
// AND carry a verbatim source quote. Internal admin endpoints
// (/api/admin/data/claims) bypass this gate by design — they're the auditing
// surface and need to see unreviewed candidates.
//
// Research-sandbox / internal tooling can opt out per-request by sending
// ?include_unreviewed=true. The default (no param) is the strict gate.
//
// As of 2026-05-02 the served-tier vocabulary includes 'ai_vouched' as the
// transition state until Phase-2.5 multi-critic consensus is in place; once
// that ships, the public default tightens to 'ai_reviewed' and up.
// See docs/phased-roadmap-ai-only.md for the rationale.
const REVIEW_GATE_TIERS = ['ai_vouched', 'ai_reviewed', 'human_verified', 'edited'];
const REVIEW_GATE_SQL = `c.review_status IN ('${REVIEW_GATE_TIERS.join("','")}') AND c.source_quote IS NOT NULL AND c.source_quote != ''`;
function shouldApplyReviewGate(req) {
  return req.query.include_unreviewed !== 'true';
}

// Single-source-of-truth SQL fragment for the 6-clause "entity needs partner
// attention" rule. Reused by /api/admin/review/entities (filter + counts) and
// available for /api/admin/review/source-progress to consolidate later.
const INCOMPLETE_PREDICATE = `(
  e.scientific_name IS NULL OR
  e.bio_category IS NULL OR
  e.taxonomy_path IS NULL OR
  e.primary_role IS NULL OR
  (e.primary_role = 'crop' AND e.crop_type IS NULL) OR
  COALESCE(e.needs_dedup, 0) = 1
)`;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.redirect('/admin/review'));

// ── Region list (flattened from regions.json — country/subdivision bbox presets) ──
// Restored to backend/ on 2026-05-07; previously lived in ui-prototype/src/regions.json
// but was orphaned when the explorer was removed in commit b4e40c2.
const REGIONS_DATA = require('./regions.json');
const REGION_NAMES = [];
for (const [country, data] of Object.entries(REGIONS_DATA)) {
  REGION_NAMES.push(country);
  if (data.subdivisions) {
    for (const sub of data.subdivisions) REGION_NAMES.push(sub.name);
  }
}
REGION_NAMES.sort();

app.get('/api/admin/regions', (req, res) => {
  res.json({ regions: REGION_NAMES, structured: REGIONS_DATA });
});

/**
 * GET /api/admin/autocomplete/biota
 * Search crops and/or pests_pathogens by name prefix.
 * ?q=mangi&scope=crops|pests|all (default: all)
 * Only returns results when match count <= 20.
 */
app.get('/api/admin/autocomplete/biota', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const scope = req.query.scope || 'all';
    const db = await getSqliteDb();
    const pattern = `%${q}%`;
    let items = [];

    if (scope === 'crops' || scope === 'all') {
      const crops = await db.all(
        `SELECT scientific_name, common_name, 'plantae' as bio_category, 'crops' as "table"
         FROM crops
         WHERE scientific_name LIKE ? COLLATE NOCASE OR common_name LIKE ? COLLATE NOCASE
         LIMIT 21`,
        [pattern, pattern]
      );
      items = items.concat(crops);
    }
    if (scope === 'pests' || scope === 'all') {
      const pests = await db.all(
        `SELECT scientific_name, common_name, organism_type as bio_category, 'pests_pathogens' as "table"
         FROM pests_pathogens
         WHERE scientific_name LIKE ? COLLATE NOCASE OR common_name LIKE ? COLLATE NOCASE
         LIMIT 21`,
        [pattern, pattern]
      );
      items = items.concat(pests);
    }

    // Only show suggestions when narrow enough
    if (items.length > 20) return res.json({ items: [] });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SQLite Database ───────────────────────────────────────────────────────────
let sqliteDb = null;

async function getSqliteDb() {
  if (!sqliteDb) {
    sqliteDb = await open({
      filename: CORPUS_DB,
      driver: sqlite3.Database
    });
    await sqliteDb.exec(ATTACH_RAW_SQL);
  }
  return sqliteDb;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute a confidence label from record/locality counts.
 */
function confidenceLabel(recordCount, localityCount) {
  if (recordCount >= 10 && localityCount >= 3) return 'strong';
  if (recordCount >= 5 || localityCount >= 2) return 'moderate';
  return 'weak';
}

/**
 * Resolve a crop name to an entity, falling back to genus-only match.
 * @param {object} db - sqlite database handle
 * @param {string} cropName - scientific name to look up
 * @param {string} [extraWhere] - additional WHERE clause (e.g. for companion_scores existence check)
 * @param {Array} [extraParams] - params for extraWhere
 * @returns {object|null} entity row or null
 */
async function resolveCropEntity(db, cropName, extraWhere = '', extraParams = []) {
  const baseQuery = `SELECT e.id FROM entities e
     WHERE e.scientific_name = ? COLLATE NOCASE AND e.primary_role = 'crop'
     ${extraWhere} LIMIT 1`;
  let ent = await db.get(baseQuery, [cropName, ...extraParams]);
  if (!ent) {
    const genus = cropName.split(' ')[0];
    const fallbackQuery = `SELECT e.id FROM entities e
       WHERE e.scientific_name = ? COLLATE NOCASE AND e.primary_role = 'crop' LIMIT 1`;
    ent = await db.get(fallbackQuery, [genus]);
  }
  return ent || null;
}

/** Common entity column list for SELECT queries. */
const ENTITY_SELECT_COLS = `id, scientific_name, common_name, variety_name, parent_entity_id, grin_accession, family, family_common_name, genus,
              kingdom, phylum, taxon_class, taxon_order,
              bio_category, primary_role, agroeco_functions, data_completeness,
              crop_type, climate_zone, growth_habit, growth_rate, growth_form,
              days_to_harvest, min_root_depth_cm, nitrogen_fixation,
              optimal_temp_min, optimal_temp_max, tolerance_temp_min, tolerance_temp_max,
              optimal_humidity_min, optimal_humidity_max,
              optimal_precip_min, optimal_precip_max,
              optimal_ph_min, optimal_ph_max,
              optimal_soil_moisture, optimal_soil_texture, optimal_light,
              soil_nutriments, soil_salinity, degree_days_base10,
              vulnerable_host_stage, favorable_season, known_natural_enemies,
              favorable_soil_organic_matter, wind_sensitivity, leaf_wetness_hours, thermal_kill_point,
              average_height_cm, maximum_height_cm,
              spread_cm, duration, edible, vegetable, edible_part,
              organism_type, pest_mobility,
              trefle_synced_at, source_table, created_at, updated_at`;

// ── API Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/status
 * Health check
 */
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', database: 'sqlite', timestamp: new Date().toISOString() });
});

/**
 * GET /api/varieties/:species_id
 * Returns variety entities under a species, with serializer-side trait
 * inheritance from the parent species (climate-envelope traits inherit;
 * biology/resistance traits do not). Each trait carries a `source` tag
 * indicating whether it's variety-specific, inherited, or no-data.
 *
 * Phase Variety (spec 2026-05-11).
 */
app.get('/api/varieties/:species_id', async (req, res, next) => {
  const speciesId = parseInt(req.params.species_id, 10);
  // If not a numeric id, fall through to the legacy /api/varieties/:cropName handler below.
  if (isNaN(speciesId) || speciesId <= 0) return next();

  const db = await getSqliteDb();
  const species = await db.get(
    `SELECT id, scientific_name, common_name, family, genus,
            ph_min, ph_max, optimal_temp_min, optimal_temp_max,
            optimal_precip_min, optimal_precip_max, optimal_light,
            optimal_soil_moisture, optimal_soil_texture,
            thermal_min, thermal_max, favorable_temp_min, favorable_temp_max,
            favorable_humidity
     FROM entities WHERE id = ?`,
    speciesId
  );
  if (!species) return res.status(404).json({ error: 'species not found' });

  const varieties = await db.all(
    `SELECT id, variety_name, common_name, grin_accession, needs_dedup,
            ph_min, ph_max, optimal_temp_min, optimal_temp_max,
            optimal_precip_min, optimal_precip_max, optimal_light,
            optimal_soil_moisture, optimal_soil_texture,
            thermal_min, thermal_max, favorable_temp_min, favorable_temp_max,
            favorable_humidity,
            host_range, vulnerable_host_stage, voltinism,
            crop_damage_type, frac_group
     FROM entities WHERE parent_entity_id = ?
     ORDER BY variety_name COLLATE NOCASE`,
    speciesId
  );

  const TRAIT_COLS = [
    'ph_min','ph_max','optimal_temp_min','optimal_temp_max',
    'optimal_precip_min','optimal_precip_max','optimal_light',
    'optimal_soil_moisture','optimal_soil_texture',
    'thermal_min','thermal_max','favorable_temp_min','favorable_temp_max',
    'favorable_humidity',
    'host_range','vulnerable_host_stage','voltinism',
    'crop_damage_type','frac_group',
  ];

  let claimCounts = [];
  if (varieties.length > 0) {
    claimCounts = await db.all(
      `SELECT object_entity_id AS eid, COUNT(*) AS c FROM claims
       WHERE object_entity_id IN (${varieties.map(()=>'?').join(',')})
       GROUP BY object_entity_id`,
      varieties.map(v => v.id)
    );
  }
  const countMap = Object.fromEntries(claimCounts.map(r => [r.eid, r.c]));

  const varietyPayloads = varieties.map(v => {
    const traits = {};
    for (const col of TRAIT_COLS) {
      const varietyVal = v[col];
      if (varietyVal != null) {
        traits[col] = { value: varietyVal, source: 'variety_specific' };
      } else if (isInheritable(col) && species[col] != null) {
        traits[col] = {
          value: species[col],
          source: 'inherited_from_species',
          parent_entity_id: species.id,
        };
      } else {
        traits[col] = {
          value: null,
          source: 'no_data',
          note: isInheritable(col)
            ? 'No reading on variety or parent species.'
            : 'Resistance/biology traits do not inherit; null means unmeasured.',
        };
      }
    }
    return {
      id: v.id,
      variety_name: v.variety_name,
      common_name: v.common_name,
      needs_dedup: !!v.needs_dedup,
      grin_accession: v.grin_accession,
      traits,
      claim_count: countMap[v.id] || 0,
    };
  });

  res.json({
    species: {
      id: species.id,
      scientific_name: species.scientific_name,
      common_name: species.common_name,
      family: species.family,
      genus: species.genus,
    },
    varieties: varietyPayloads,
  });
});

// DEPRECATED: kept for back-compat. Prefer /api/varieties/:species_id (numeric, entities-based).
/**
 * GET /api/varieties/:cropName?region=California
 * Returns variety data for a species (matched by species_name).
 */
app.get('/api/varieties/:cropName', async (req, res) => {
  try {
    const { cropName } = req.params;
    const region = req.query.region || '';
    const db = await getSqliteDb();

    const tableRow = await db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='crop_varieties'"
    );
    if (!tableRow) return res.json([]);

    // Helper: query with optional region filter, falling back to all regions
    const queryVarieties = async (nameClause, params) => {
      if (region) {
        const r = await db.all(
          `SELECT DISTINCT variety_name, region, source_name, source_url,
                  maturity_days, yield_notes, water_needs, climate_notes, traits_json
           FROM crop_varieties WHERE ${nameClause}
             AND (region = ? OR region = 'United States' OR region IS NULL)
           ORDER BY variety_name`,
          [...params, region]
        );
        if (r.length) return r;
      }
      return db.all(
        `SELECT DISTINCT variety_name, region, source_name, source_url,
                maturity_days, yield_notes, water_needs, climate_notes, traits_json
         FROM crop_varieties WHERE ${nameClause} ORDER BY variety_name`,
        params
      );
    };

    // Try exact species match first, then genus-prefix match
    let rows = await queryVarieties('species_name = ?', [cropName]);
    if (!rows.length) {
      // cropName may be a genus only (e.g. "Lactuca") — match "Lactuca sativa", "Lactuca ×" etc.
      rows = await queryVarieties("species_name LIKE ? || ' %'", [cropName]);
    }

    res.json(rows.map(r => ({
      variety_name:  r.variety_name,
      region:        r.region || null,
      source_name:   r.source_name || null,
      source_url:    r.source_url  || null,
      maturity_days: r.maturity_days || null,
      yield_notes:   r.yield_notes  || null,
      water_needs:   r.water_needs  || null,
      climate_notes: r.climate_notes || null,
      traits:        r.traits_json ? JSON.parse(r.traits_json) : null
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/crops?country=X&subdivision=Y
 * Returns crop entities with documented interactions.
 * Uses pre-aggregated crop_locality_coverage for regional filtering.
 */
app.get('/api/crops', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const country = req.query.country || '';
    const subdivision = req.query.subdivision || '';

    let rows = [];

    if (country) {
      if (subdivision) {
        rows = await db.all(`
          SELECT DISTINCT e.scientific_name AS id, e.common_name AS commonName,
                 e.crop_type AS cropType, e.taxonomy_path AS taxon_path, e.bio_category
          FROM entities e
          INNER JOIN raw.crop_locality_coverage clc ON clc.crop_name = e.scientific_name
          WHERE e.primary_role = 'crop' AND clc.country = ? AND clc.subdivision = ?
          ORDER BY e.common_name
        `, [country, subdivision]);
      }
      if (!rows.length) {
        rows = await db.all(`
          SELECT DISTINCT e.scientific_name AS id, e.common_name AS commonName,
                 e.crop_type AS cropType, e.taxonomy_path AS taxon_path, e.bio_category
          FROM entities e
          INNER JOIN raw.crop_locality_coverage clc ON clc.crop_name = e.scientific_name
          WHERE e.primary_role = 'crop' AND clc.country = ?
          ORDER BY e.common_name
        `, [country]);
      }
    }

    // Fallback: bbox grid
    if (!rows.length) {
      const bbox = req.query.bbox || '';
      const parts = bbox.split(',').map(Number);
      const [minLng, minLat, maxLng, maxLat] = parts;
      if (parts.length === 4 && parts.every(n => !isNaN(n))) {
        rows = await db.all(`
          SELECT DISTINCT e.scientific_name AS id, e.common_name AS commonName,
                 e.crop_type AS cropType, e.taxonomy_path AS taxon_path, e.bio_category
          FROM entities e
          INNER JOIN crop_grid_cells cgc ON cgc.crop_name = e.scientific_name
          WHERE e.primary_role = 'crop'
            AND cgc.lat_cell BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER)
            AND cgc.lng_cell BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER)
          ORDER BY e.common_name
        `, [minLat, maxLat, minLng, maxLng]);
      }
    }

    // Final fallback: all crop entities
    if (!rows.length) {
      rows = await db.all(`
        SELECT scientific_name AS id, common_name AS commonName,
               crop_type AS cropType, taxonomy_path AS taxon_path, bio_category
        FROM entities WHERE primary_role = 'crop'
        ORDER BY common_name
      `);
    }

    res.json(rows.map(r => ({
      id: r.id,
      label: r.commonName || r.id,
      commonName: r.commonName,
      cropType: r.cropType || 'Other Plants',
      group: 'crop',
      bioCategory: r.bio_category || getBioCategory(r.taxon_path || '')
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/crops/:cropId/interactions
 * Get all interactions for a crop from the claims table.
 */
app.get('/api/crops/:cropId/interactions', async (req, res) => {
  try {
    const { cropId } = req.params;
    const db = await getSqliteDb();

    // Resolve crop to entity
    const entity = await db.get(
      'SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE AND primary_role = \'crop\' LIMIT 1',
      [cropId]
    );
    if (!entity) return res.status(404).json({ error: `Crop not found: ${cropId}` });

    const reviewGateClause = shouldApplyReviewGate(req) ? `AND ${REVIEW_GATE_SQL}` : '';
    const claims = await db.all(`
      SELECT e.scientific_name AS target_name,
             c.interaction_type_raw AS interaction_type,
             c.interaction_category,
             c.effect_direction,
             c.interaction_count AS count
      FROM claims c
      JOIN entities e ON e.id = CASE
        WHEN c.subject_entity_id = ? THEN c.object_entity_id
        ELSE c.subject_entity_id
      END
      WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
        AND c.applied_weight != 0
        ${reviewGateClause}
      ORDER BY c.interaction_count DESC
    `, [entity.id, entity.id, entity.id]);

    const classified = { pests: [], beneficials: [], other: [] };
    for (const c of claims) {
      const item = {
        name: c.target_name,
        interaction: c.interaction_type,
        category: c.interaction_category,
        count: c.count
      };
      if (c.effect_direction === 'harmful') classified.pests.push(item);
      else if (c.effect_direction === 'beneficial') classified.beneficials.push(item);
      else classified.other.push(item);
    }

    // ──────────────────────────────────────────────────────────────
    // variety_findings rollup — per-pest summary of variety-attached claims
    // (Phase Variety, 2026-05-11)
    // ──────────────────────────────────────────────────────────────
    const varietyFindingsRows = await db.all(`
      SELECT
        pest.scientific_name AS pest_name,
        COUNT(DISTINCT variety.id) AS reported_varieties,
        SUM(CASE WHEN c.effect_direction = 'beneficial' THEN 1 ELSE 0 END) AS with_resistance,
        SUM(CASE WHEN c.effect_direction = 'harmful'    THEN 1 ELSE 0 END) AS with_susceptibility,
        SUM(CASE WHEN c.effect_direction NOT IN ('beneficial','harmful')
                 OR c.effect_direction IS NULL THEN 1 ELSE 0 END) AS neutral_or_unspecified
      FROM claims c
      JOIN entities variety ON variety.id = c.object_entity_id
      JOIN entities pest    ON pest.id    = c.subject_entity_id
      WHERE variety.parent_entity_id = ?
        AND c.interaction_category IN ('pest_pressure','pathogen_pressure','herbivory')
        AND c.review_status IN ('ai_consensus_verified','human_verified','edited')
      GROUP BY pest.scientific_name
      ORDER BY reported_varieties DESC
    `, entity.id);

    const variety_findings = {};
    for (const r of varietyFindingsRows) {
      variety_findings[r.pest_name] = {
        reported_varieties: r.reported_varieties,
        with_resistance: r.with_resistance,
        with_susceptibility: r.with_susceptibility,
        neutral_or_unspecified: r.neutral_or_unspecified,
        expand_url: `/api/crops/${encodeURIComponent(cropId)}/interactions?expand_varieties=${encodeURIComponent(r.pest_name)}`,
      };
    }

    // Optional: per-variety detail when ?expand_varieties=<pest> is set
    let expanded_variety_findings = null;
    const expandPest = req.query.expand_varieties;
    if (expandPest) {
      const expRows = await db.all(`
        SELECT variety.variety_name, variety.id AS variety_id,
               c.effect_direction, c.source_quote, c.source_page, c.source_id
        FROM claims c
        JOIN entities variety ON variety.id = c.object_entity_id
        JOIN entities pest    ON pest.id    = c.subject_entity_id
        WHERE variety.parent_entity_id = ?
          AND pest.scientific_name = ?
          AND c.review_status IN ('ai_consensus_verified','human_verified','edited')
        ORDER BY variety.variety_name
      `, [entity.id, expandPest]);
      expanded_variety_findings = { [expandPest]: expRows };
    }

    res.json({
      crop: cropId,
      pests: classified.pests.sort((a, b) => b.count - a.count),
      beneficials: classified.beneficials.sort((a, b) => b.count - a.count),
      other: classified.other.sort((a, b) => b.count - a.count),
      variety_findings,
      ...(expanded_variety_findings ? { expanded_variety_findings } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/species/:speciesId/controls
 * Get chemical controls for a pest
 */
app.get('/api/species/:speciesId/controls', async (req, res) => {
  try {
    const { speciesId } = req.params;

    const controls = [
      {
        name: 'Neem Oil',
        type: 'botanical',
        effectiveness: 'high',
        cost: 'low',
        notes: 'Organic option, multiple applications needed'
      },
      {
        name: 'Insecticidal Soap',
        type: 'organic',
        effectiveness: 'medium',
        cost: 'low',
        notes: 'Safe for beneficial insects'
      },
      {
        name: 'Spinosad',
        type: 'biological',
        effectiveness: 'medium',
        cost: 'medium',
        notes: 'Effective on larvae'
      }
    ];

    res.json({ species: speciesId, controls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/neighborhood/:id?country=X&subdivision=Y
 * Get BFS neighborhood around a species (3 hops) from claims table.
 *
 * Regional confidence tiers (logged/predicted/global) still use
 * interaction_locality_coverage and species_locality_coverage tables.
 */
app.get('/api/neighborhood/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getSqliteDb();
    const country = req.query.country || '';
    const subdivision = req.query.subdivision || '';
    const hasRegion = !!country;

    // Build entity lookup for visited nodes
    const entityCache = new Map();
    async function getEntity(scientificName) {
      const key = scientificName.toLowerCase();
      if (entityCache.has(key)) return entityCache.get(key);
      const e = await db.get(
        `SELECT id, scientific_name, common_name, primary_role, bio_category, crop_type, taxonomy_path
         FROM entities WHERE scientific_name = ? COLLATE NOCASE LIMIT 1`,
        [scientificName]
      );
      if (e) entityCache.set(key, e);
      return e;
    }

    // Load regional presence sets
    let regionalSpecies = null;
    let loggedPairs = null;
    let tablesExist = false;

    if (hasRegion) {
      try {
        const testRow = await db.get("SELECT name FROM raw.sqlite_master WHERE type='table' AND name='species_locality_coverage'");
        tablesExist = !!testRow;
      } catch (_) { tablesExist = false; }

      if (tablesExist) {
        const presenceRows = subdivision
          ? await db.all('SELECT species_name FROM raw.species_locality_coverage WHERE country = ? AND (subdivision = ? OR subdivision = ?)',
              [country, subdivision, ''])
          : await db.all('SELECT species_name FROM raw.species_locality_coverage WHERE country = ?', [country]);
        regionalSpecies = new Set(presenceRows.map(r => r.species_name));

        const cropPresence = subdivision
          ? await db.all('SELECT crop_name FROM raw.crop_locality_coverage WHERE country = ? AND (subdivision = ? OR subdivision = ?)',
              [country, subdivision, ''])
          : await db.all('SELECT crop_name FROM raw.crop_locality_coverage WHERE country = ?', [country]);
        for (const r of cropPresence) regionalSpecies.add(r.crop_name);

        const loggedRows = subdivision
          ? await db.all('SELECT source_name, target_name FROM raw.interaction_locality_coverage WHERE country = ? AND subdivision = ?',
              [country, subdivision])
          : await db.all('SELECT source_name, target_name FROM raw.interaction_locality_coverage WHERE country = ?', [country]);
        loggedPairs = new Set(loggedRows.map(r => `${r.source_name}\x00${r.target_name}`));
      }
    }

    const nodes = [];
    const links = [];
    const visited = new Set(); // entity IDs

    async function bfs(entityId, scientificName, depth) {
      if (depth > 2 || visited.has(entityId) || nodes.length > 500) return;
      visited.add(entityId);

      const e = entityCache.get(scientificName.toLowerCase()) ||
        await db.get('SELECT id, scientific_name, common_name, primary_role, bio_category, crop_type FROM entities WHERE id = ?', entityId);

      nodes.push({
        id: e.scientific_name,
        label: e.common_name || e.scientific_name,
        commonName: e.common_name || null,
        cropType: e.crop_type || null,
        group: e.primary_role === 'crop' ? 'crop' : e.primary_role,
        bioCategory: e.bio_category,
        depth
      });

      if (depth >= 2) return;

      // Get claims where this entity is subject or object
      const neighborGateClause = shouldApplyReviewGate(req) ? `AND ${REVIEW_GATE_SQL}` : '';
      const neighborClaims = await db.all(`
        SELECT c.subject_entity_id, c.object_entity_id,
               c.interaction_type_raw, c.interaction_count,
               e_sub.scientific_name AS sub_name,
               e_obj.scientific_name AS obj_name
        FROM claims c
        JOIN entities e_sub ON e_sub.id = c.subject_entity_id
        JOIN entities e_obj ON e_obj.id = c.object_entity_id
        WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
          AND c.applied_weight != 0
          ${neighborGateClause}
        ORDER BY c.interaction_count DESC
        LIMIT 50
      `, [entityId, entityId]);

      for (const cl of neighborClaims) {
        const isSubject = cl.subject_entity_id === entityId;
        const neighborId = isSubject ? cl.object_entity_id : cl.subject_entity_id;
        const neighborName = isSubject ? cl.obj_name : cl.sub_name;

        // Determine link confidence tier
        let linkType = 'global';
        if (hasRegion && tablesExist) {
          const pairKey = `${cl.sub_name}\x00${cl.obj_name}`;
          if (loggedPairs && loggedPairs.has(pairKey)) {
            linkType = 'logged';
          } else if (regionalSpecies && regionalSpecies.has(neighborName)) {
            linkType = 'predicted';
          }
        }

        links.push({
          source: cl.sub_name,
          target: cl.obj_name,
          type: cl.interaction_type_raw,
          linkType
        });

        // Cache entity for neighbor
        if (!entityCache.has(neighborName.toLowerCase())) {
          const ne = await db.get(
            'SELECT id, scientific_name, common_name, primary_role, bio_category, crop_type FROM entities WHERE id = ?',
            [neighborId]
          );
          if (ne) entityCache.set(ne.scientific_name.toLowerCase(), ne);
        }

        await bfs(neighborId, neighborName, depth + 1);
      }
    }

    // Resolve seed entity
    const seedEntity = await getEntity(id);
    if (!seedEntity) return res.status(404).json({ error: `Species not found: ${id}` });

    await bfs(seedEntity.id, seedEntity.scientific_name, 0);

    const slicedLinks = links.slice(0, 500);
    const linkedIds = new Set([seedEntity.scientific_name]);
    slicedLinks.forEach(l => { linkedIds.add(l.source); linkedIds.add(l.target); });
    const filteredNodes = nodes.filter(n => linkedIds.has(n.id));

    res.json({
      nodes: filteredNodes,
      links: slicedLinks,
      region: hasRegion ? { country, subdivision, tablesReady: tablesExist } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/search
 * Search entities by name with auto-complete
 */
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (query.length < 2) {
      return res.json({ results: [] });
    }

    const db = await getSqliteDb();
    const results = await db.all(
      `SELECT scientific_name AS name, common_name, primary_role, bio_category
       FROM entities
       WHERE (scientific_name LIKE ? COLLATE NOCASE OR common_name LIKE ? COLLATE NOCASE)
       ORDER BY scientific_name
       LIMIT 20`,
      [`%${query}%`, `%${query}%`]
    );

    res.json({ results: results.map(r => r.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Categories endpoint for filtering ──────────────────────────────────────

/**
 * GET /api/categories
 * Get interaction type categories for filtering
 */
app.get('/api/categories', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const categories = await db.all(
      `SELECT DISTINCT interaction_type FROM raw.interactions ORDER BY interaction_type`
    );

    res.json({
      categories: categories.map(c => ({
        value: c.interaction_type,
        label: c.interaction_type
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Planner endpoints removed 2026-04-30: AEDIN is now academic + bot-facing only.
// Planner endpoints (companions, crop-ecology, polyculture, crops, tritrophic) and
// their helper functions (computeStackingRisks, computeSharedBeneficials,
// fetchPairOrganisms) have been removed. PolyCrop owns the planner now.


// ── Admin: Extraction Pipeline ────────────────────────────────────────────────

/**
 * POST /api/admin/queue
 * Add a URL to the extraction queue.
 * Body: { url, source_type? }
 * Dedup: checks extraction_queue.url and sources.url
 */
app.post('/api/admin/queue', async (req, res) => {
  try {
    const { url, source_type = 'unknown' } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const db = await getSqliteDb();
    const inQueue = await db.get('SELECT id, status FROM extraction_queue WHERE url = ?', url);
    if (inQueue) {
      if (inQueue.status === 'failed') {
        await db.run(
          `UPDATE extraction_queue SET status = 'pending', error_message = NULL, started_at = NULL, completed_at = NULL WHERE id = ?`,
          inQueue.id
        );
        return res.json({ id: inQueue.id, url, status: 'pending', requeued: true });
      }
      return res.json({ alreadyExists: true, id: inQueue.id, url, status: 'already_queued' });
    }

    const inSources = await db.get('SELECT id FROM sources WHERE url = ?', url);
    if (inSources) return res.json({ alreadyExists: true, source_id: inSources.id, url, status: 'already_ingested' });

    const result = await db.run(
      `INSERT INTO extraction_queue (url, source_type) VALUES (?, ?)`,
      [url, source_type]
    );
    res.json({ id: result.lastID, url, status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/queue/:id/retry
 * Reset a failed queue item to pending and immediately process it.
 */
app.post('/api/admin/queue/:id/retry', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const item = await db.get('SELECT * FROM extraction_queue WHERE id = ?', req.params.id);
    if (!item) return res.status(404).json({ error: 'queue item not found' });
    if (item.status !== 'failed') return res.status(400).json({ error: 'only failed items can be retried' });

    await db.run(
      `UPDATE extraction_queue SET status = 'running', error_message = NULL, started_at = datetime('now'), completed_at = NULL WHERE id = ?`,
      item.id
    );
    try {
      const { sourceId, stagedCount } = await extractSource(item, db);
      await db.run(
        `UPDATE extraction_queue SET status = 'done', completed_at = datetime('now'), source_id = ? WHERE id = ?`,
        [sourceId, item.id]
      );
      res.json({ id: item.id, status: 'done', stagedCount });
    } catch (err) {
      await db.run(
        `UPDATE extraction_queue SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?`,
        [err.message, item.id]
      );
      res.status(500).json({ id: item.id, status: 'failed', error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/queue/:id
 * Delete a queue item and its associated staging rows.
 */
app.delete('/api/admin/queue/:id', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const item = await db.get('SELECT * FROM extraction_queue WHERE id = ?', req.params.id);
    if (!item) return res.status(404).json({ error: 'queue item not found' });

    // Delete associated staging rows and source
    await db.run('DELETE FROM extraction_staging WHERE queue_id = ?', item.id);
    if (item.source_id) {
      await db.run('DELETE FROM sources WHERE id = ?', item.source_id);
    }
    await db.run('DELETE FROM extraction_queue WHERE id = ?', item.id);

    res.json({ id: item.id, deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/queue
 * List all queue items with status counts.
 */
app.get('/api/admin/queue', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const items = await db.all(
      `SELECT eq.*, s.title as source_title
       FROM extraction_queue eq
       LEFT JOIN sources s ON s.id = eq.source_id
       ORDER BY eq.added_at DESC`
    );
    const countRows = await db.all(
      `SELECT status, COUNT(*) as n FROM extraction_queue GROUP BY status`
    );
    const counts = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const r of countRows) counts[r.status] = r.n;
    res.json({ items, counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/queue/run
 * Process the next batch of pending items.
 * Body: { limit? } — default 5
 */
app.post('/api/admin/queue/run', async (req, res) => {
  try {
    const limit = parseInt(req.body?.limit || 5, 10);
    const db = await getSqliteDb();
    const items = await db.all(
      `SELECT * FROM extraction_queue WHERE status = 'pending' ORDER BY priority ASC, added_at ASC LIMIT ?`,
      limit
    );

    let processed = 0, failed = 0, stagingCount = 0;

    for (const item of items) {
      await db.run(
        `UPDATE extraction_queue SET status = 'running', started_at = datetime('now') WHERE id = ?`,
        item.id
      );
      try {
        const { sourceId, stagedCount } = await extractSource(item, db);
        await db.run(
          `UPDATE extraction_queue SET status = 'done', completed_at = datetime('now'), source_id = ? WHERE id = ?`,
          [sourceId, item.id]
        );
        processed++;
        stagingCount += stagedCount;
      } catch (err) {
        await db.run(
          `UPDATE extraction_queue SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?`,
          [err.message, item.id]
        );
        failed++;
      }
    }

    res.json({ processed, failed, staged: stagingCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/staging
 * List staged claims. Query: ?status=pending|approved|rejected
 */
app.get('/api/admin/staging', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const region = req.query.region || '';
    const search = req.query.search || '';
    const db = await getSqliteDb();
    const items = await db.all(
      `SELECT es.*, s.title as source_title, eq.url as source_url
       FROM extraction_staging es
       LEFT JOIN sources s ON s.id = es.source_id
       LEFT JOIN extraction_queue eq ON eq.id = es.queue_id
       WHERE es.review_status = ?
       ORDER BY es.created_at DESC`,
      status
    );

    const enrichedItems = await Promise.all(items.map(async (item) => {
      let parsed = {};
      try { parsed = JSON.parse(item.payload || '{}'); } catch {}

      // Determine claim_type and map to subject/object biota format
      let claim_type = item.target_table;
      let subject_biota = '';
      let subject_bio_cat = '';
      let object_biota = '';
      let object_bio_cat = '';
      let relationship = '';
      let direction_severity = '';

      if (item.target_table === 'interactions') {
        const isBiocontrol = parsed.interaction_type === 'biocontrol';
        claim_type = isBiocontrol ? 'biocontrol' : 'interaction';
        subject_biota = parsed.subject_crop || '';
        object_biota = parsed.object_crop || '';
        // Resolve bio_category from entities if possible, otherwise infer from context
        const subEnt = subject_biota ? await db.get('SELECT bio_category FROM entities WHERE scientific_name = ? COLLATE NOCASE', [subject_biota]) : null;
        const objEnt = object_biota ? await db.get('SELECT bio_category FROM entities WHERE scientific_name = ? COLLATE NOCASE', [object_biota]) : null;
        // For biocontrol: subject is beneficial (invertebrate), object is pest (invertebrate)
        subject_bio_cat = subEnt?.bio_category || (isBiocontrol ? 'invertebrate' : 'plantae');
        object_bio_cat = objEnt?.bio_category || (isBiocontrol ? 'invertebrate' : 'plantae');
        relationship = parsed.interaction_type || '';
        direction_severity = parsed.effect_direction || '';
      } else if (item.target_table === 'crop_vulnerabilities') {
        claim_type = 'vulnerability';
        // Plant-left rule: crop is always subject
        subject_biota = parsed.crop || '';
        subject_bio_cat = 'plantae';
        object_biota = parsed.pest_scientific_name || parsed.pest_common_name || '';
        const orgType = parsed.pest_organism_type || '';
        const derived = bioCategoryFromOrganismType(orgType);
        object_bio_cat = derived !== 'other' ? derived : (orgType || 'unknown');
        relationship = parsed.damage_type || '';
        direction_severity = 'harmful';
      } else if (item.target_table === 'crops') {
        claim_type = 'enrichment';
        subject_biota = parsed.scientific_name || '';
        subject_bio_cat = 'plantae';
        // Show which fields are being enriched
        const enrichFields = ['ph_min','ph_max','min_root_depth_cm','nitrogen_fixation',
          'growth_rate','growth_habit','days_to_harvest','soil_texture','soil_humidity',
          'min_temp_c','max_temp_c'].filter(f => parsed[f] != null);
        relationship = enrichFields.join(', ') || 'profile data';
      }

      return {
        ...item,
        claim_type,
        subject_biota,
        subject_bio_cat,
        object_biota,
        object_bio_cat,
        relationship,
        direction_severity,
        confidence_score: parsed.confidence_score != null ? parsed.confidence_score : null,
        evidence_tier: parsed.evidence_tier || null,
        regional_context: parsed.regional_context || parsed.region_context || null,
        extracted_claim: parsed.extracted_claim || null,
        source_quote: parsed.source_quote || null,
        mechanism: parsed.mechanism || null,
        effect_magnitude: parsed.effect_magnitude || null,
        study_scale: parsed.study_scale || null,
        source_page: parsed.source_page || null,
        affected_part: parsed.affected_part || null,
        season: parsed.season || null,
        crop_growth_stage: parsed.crop_growth_stage || null,
        // Keep raw payload for edit panel
        payload_parsed: parsed,
      };
    }));

    const filteredItems = enrichedItems.filter(item => {
      // Region filter
      if (region && item.regional_context !== region) return false;
      // Search filter — check both subject and object
      if (search) {
        const s = search.toLowerCase();
        const inSubject = (item.subject_biota || '').toLowerCase().includes(s);
        const inObject = (item.object_biota || '').toLowerCase().includes(s);
        if (!inSubject && !inObject) return false;
      }
      return true;
    });

    res.json({ items: filteredItems, total: filteredItems.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/staging/:id
 * Edit staging payload fields before approving.
 * Body: { field1: value1, field2: value2, ... } — merged into existing payload.
 */
app.put('/api/admin/staging/:id', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const staging = await db.get('SELECT * FROM extraction_staging WHERE id = ?', req.params.id);
    if (!staging) return res.status(404).json({ error: 'staging row not found' });
    if (staging.review_status !== 'pending') {
      return res.status(422).json({ error: 'can only edit pending claims' });
    }

    const existing = JSON.parse(staging.payload || '{}');
    const updates = req.body || {};
    const merged = { ...existing, ...updates };

    await db.run(
      'UPDATE extraction_staging SET payload = ? WHERE id = ?',
      [JSON.stringify(merged), staging.id]
    );

    res.json({ id: staging.id, payload: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/staging/:id/approve
 * Promote staged payload to the unified claims/entities tables.
 */
app.post('/api/admin/staging/:id/approve', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const staging = await db.get('SELECT * FROM extraction_staging WHERE id = ?', req.params.id);
    if (!staging) return res.status(404).json({ error: 'staging row not found' });

    if (staging.review_status === 'approved') {
      return res.json({ id: staging.id, alreadyApproved: true });
    }

    const payload = JSON.parse(staging.payload);
    let inserted_id = null;

    if (staging.target_table === 'interactions' || staging.target_table === 'crop_vulnerabilities') {
      // Both interaction and vulnerability claims go into the unified claims table
      const subjectName = payload.subject_crop || payload.crop;
      const objectName = payload.object_crop || payload.pest_scientific_name;

      const subjectEnt = await db.get(
        'SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE', [subjectName]
      );
      let objectEnt = await db.get(
        'SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE', [objectName]
      );

      if (!subjectEnt) {
        await db.run(
          `UPDATE extraction_staging SET review_status = 'rejected', review_note = 'subject entity not found', reviewed_at = datetime('now') WHERE id = ?`,
          staging.id
        );
        return res.status(422).json({ error: 'subject entity not found', subject: subjectName });
      }

      // Auto-create object entity if not found (for new pests/pathogens)
      if (!objectEnt) {
        const orgType = payload.pest_organism_type || 'unknown';
        const bioCategory = bioCategoryFromOrganismType(orgType) || 'invertebrate';
        const primaryRole = primaryRoleFromOrganismType(orgType);

        const r = await db.run(
          `INSERT INTO entities (scientific_name, common_name, bio_category, primary_role, organism_type, source_table, data_completeness)
           VALUES (?, ?, ?, ?, ?, 'llm_extraction', 'manual')`,
          [objectName, payload.pest_common_name || null, bioCategory, primaryRole, orgType]
        );
        objectEnt = { id: r.lastID };
      }

      // Determine category and effect
      let category = payload.interaction_type || payload.damage_type || 'facilitation';
      let effect = payload.effect_direction || payload.severity || 'neutral';
      // Map severity to effect for vulnerabilities
      if (staging.target_table === 'crop_vulnerabilities') {
        category = 'pest_pressure';
        effect = 'harmful';
      }

      const r = await db.run(
        `INSERT INTO claims (
          subject_entity_id, object_entity_id, source_id, data_tier,
          interaction_type_raw, interaction_category, effect_direction,
          confidence_score, evidence_tier,
          extracted_claim, source_quote, source_page,
          effect_magnitude, study_scale, regional_context, season_context
        ) VALUES (?, ?, ?, 'tier1_paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          subjectEnt.id, objectEnt.id, staging.source_id,
          payload.interaction_type || payload.damage_type || 'unknown',
          category, effect,
          payload.confidence_score || 0.5, payload.evidence_tier || 'inferred',
          payload.extracted_claim || null, payload.source_quote || null,
          payload.source_page || null, payload.effect_magnitude || null,
          payload.study_scale || null, payload.regional_context || null,
          payload.season || null
        ]
      );
      inserted_id = r.lastID;

    } else if (staging.target_table === 'crops' || staging.target_table === 'pests_pathogens') {
      // Entity enrichment — update the entities table directly
      if (!payload.scientific_name) {
        return res.status(422).json({ error: 'payload missing scientific_name' });
      }

      const ent = await db.get(
        'SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE', [payload.scientific_name]
      );
      if (ent) {
        const updateFields = ['common_name', 'nitrogen_fixation', 'ph_min', 'ph_max',
          'min_root_depth_cm', 'soil_texture', 'soil_humidity', 'soil_nutriments',
          'min_temp_c', 'max_temp_c', 'growth_rate', 'growth_habit',
          'days_to_harvest', 'native_zones', 'introduced_zones', 'organism_type'];
        const setClauses = updateFields.filter(f => payload[f] != null).map(f => `${f} = ?`);
        const setValues = updateFields.filter(f => payload[f] != null).map(f => payload[f]);

        if (setClauses.length > 0) {
          await db.run(
            `UPDATE entities SET ${setClauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
            [...setValues, ent.id]
          );
        }
        inserted_id = ent.id;
      } else {
        // Create new entity
        const bioCategory = payload.organism_type
          ? (bioCategoryFromOrganismType(payload.organism_type) || 'invertebrate')
          : 'plantae';
        const primaryRole = payload.organism_type
          ? primaryRoleFromOrganismType(payload.organism_type)
          : 'crop';

        const r = await db.run(
          `INSERT INTO entities (scientific_name, common_name, bio_category, primary_role, source_table, data_completeness)
           VALUES (?, ?, ?, ?, 'llm_extraction', 'manual')`,
          [payload.scientific_name, payload.common_name || null, bioCategory, primaryRole]
        );
        inserted_id = r.lastID;
      }

      // Merge into pending_crops for Trefle enrichment
      const pc = await db.get(
        'SELECT id, enrichment_payload FROM pending_crops WHERE scientific_name = ? COLLATE NOCASE',
        [payload.scientific_name]
      );
      const existingPayload = pc?.enrichment_payload ? JSON.parse(pc.enrichment_payload) : {};
      const mergedPayload = { ...existingPayload };
      for (const k of Object.keys(payload)) {
        if (payload[k] != null) mergedPayload[k] = payload[k];
      }
      if (pc) {
        await db.run('UPDATE pending_crops SET enrichment_payload = ? WHERE id = ?',
          [JSON.stringify(mergedPayload), pc.id]);
      } else {
        await db.run(
          `INSERT INTO pending_crops (scientific_name, common_name, source_id, enrichment_payload) VALUES (?, ?, ?, ?)`,
          [payload.scientific_name, payload.common_name || null, staging.source_id, JSON.stringify(mergedPayload)]
        );
      }
    }

    await db.run(
      `UPDATE extraction_staging SET review_status = 'approved', reviewed_at = datetime('now') WHERE id = ?`,
      staging.id
    );

    // Propagate to linked live claim (idempotent — re-approve just re-asserts human_verified).
    if (['interactions', 'crop_vulnerabilities', 'attractor_relationship'].includes(staging.target_table)) {
      await db.run(
        "UPDATE claims SET review_status = 'human_verified', reviewed_at = datetime('now') WHERE staging_id = ?",
        staging.id
      );
    } else if (staging.target_table === 'entity_trait') {
      await db.run(
        "UPDATE entity_trait_claims SET review_status = 'human_verified', reviewed_at = datetime('now') WHERE staging_id = ?",
        staging.id
      );
    }

    res.json({ id: staging.id, inserted_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/staging/:id/reject
 * Discard a staged claim.
 * Body: { note? }
 */
app.post('/api/admin/staging/:id/reject', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const stagingId = parseInt(req.params.id, 10);
    const { note = null } = req.body || {};
    const staging = await db.get('SELECT target_table FROM extraction_staging WHERE id = ?', stagingId);
    await db.run(
      `UPDATE extraction_staging SET review_status = 'rejected', review_note = ?, reviewed_at = datetime('now') WHERE id = ?`,
      [note, stagingId]
    );

    // Propagate to linked live claim (idempotent).
    if (staging) {
      if (['interactions', 'crop_vulnerabilities', 'attractor_relationship'].includes(staging.target_table)) {
        await db.run(
          "UPDATE claims SET review_status = 'human_rejected', reviewed_at = datetime('now') WHERE staging_id = ?",
          stagingId
        );
      } else if (staging.target_table === 'entity_trait') {
        await db.run(
          "UPDATE entity_trait_claims SET review_status = 'human_rejected', reviewed_at = datetime('now') WHERE staging_id = ?",
          stagingId
        );
      }
    }

    res.json({ id: stagingId, review_status: 'rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/staging/:id/flag
 * Body: { note? }
 * Sets the staging row's review_status='flagged' and propagates to the
 * linked live claim/trait as 'disputed' (the canonical "second-eyes" state).
 */
app.post('/api/admin/staging/:id/flag', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const stagingId = parseInt(req.params.id, 10);
    if (!stagingId) return res.status(400).json({ error: 'invalid staging id' });
    const { note = null } = req.body || {};
    const staging = await db.get('SELECT target_table FROM extraction_staging WHERE id = ?', stagingId);
    await db.run(
      `UPDATE extraction_staging SET review_status = 'flagged', review_note = ?, reviewed_at = datetime('now') WHERE id = ?`,
      [note, stagingId]
    );
    if (staging) {
      if (['interactions', 'crop_vulnerabilities', 'attractor_relationship'].includes(staging.target_table)) {
        await db.run(
          "UPDATE claims SET review_status = 'disputed', reviewed_at = datetime('now') WHERE staging_id = ?",
          stagingId
        );
      } else if (staging.target_table === 'entity_trait') {
        await db.run(
          "UPDATE entity_trait_claims SET review_status = 'disputed', reviewed_at = datetime('now') WHERE staging_id = ?",
          stagingId
        );
      }
    }
    res.json({ id: stagingId, review_status: 'flagged' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/staging/:id/correct
 * Body: { field_path, action, corrected_value?, note?, reviewer_id? }
 * UPSERTs a per-field correction record. If action='edited', also writes the
 * corrected value back into the staging row's payload JSON. Auto-promotes
 * review_status when all reviewable fields have been handled.
 */
app.post('/api/admin/staging/:id/correct', async (req, res) => {
  const stagingId = parseInt(req.params.id, 10);
  if (!stagingId) return res.status(400).json({ error: 'invalid staging id' });
  const { field_path, action, corrected_value, note, reviewer_id } = req.body || {};
  if (!field_path || typeof field_path !== 'string') return res.status(400).json({ error: 'field_path required' });
  if (!['correct', 'edited', 'rejected'].includes(action)) return res.status(400).json({ error: 'invalid action' });
  if (action === 'edited' && (corrected_value === undefined || corrected_value === null)) {
    return res.status(400).json({ error: 'edited action requires corrected_value' });
  }

  // Default note for rejected actions when none provided — ensures agents always
  // see a human-readable reason in the feedback loop rather than a bare null.
  const noteFinal = (action === 'rejected' && (!note || !String(note).trim()))
    ? 'correct answer unknown / not stated in source'
    : (note || null);

  try {
    const db = await getSqliteDb();
    const staging = await db.get('SELECT id, payload, review_status FROM extraction_staging WHERE id = ?', [stagingId]);
    if (!staging) return res.status(404).json({ error: 'staging row not found' });

    let payload = {};
    try { payload = JSON.parse(staging.payload || '{}'); } catch { payload = {}; }
    const original_value = (payload && field_path in payload) ? String(payload[field_path] ?? '') : null;

    // UPSERT correction record
    await db.run(
      `INSERT INTO staging_field_corrections (staging_id, field_path, action, original_value, corrected_value, note, reviewer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(staging_id, field_path) DO UPDATE SET
         action = excluded.action,
         corrected_value = excluded.corrected_value,
         note = excluded.note,
         reviewer_id = excluded.reviewer_id,
         created_at = datetime('now')`,
      [stagingId, field_path, action, original_value, corrected_value ?? null, noteFinal, reviewer_id ?? null]
    );

    // If action='edited', persist corrected value back into the staging payload
    if (action === 'edited') {
      payload[field_path] = corrected_value;
      await db.run('UPDATE extraction_staging SET payload = ? WHERE id = ?', [JSON.stringify(payload), stagingId]);

      // Bridge the value-edit into extractor_corrections so the lessons aggregator
      // (aggregate-corrections.js → extractor_lessons → {{CORRECTION_LESSONS}} in
      // extractor.md) can learn from it. Only value-edits are extractor lessons;
      // 'correct'/'rejected' flags carry no original→corrected pair. Delete-then-insert
      // keeps one row per (staging row, field), mirroring the UPSERT above so repeated
      // edits don't inflate lesson frequency. [Hermes correction-capture wiring 2026-06-16]
      await db.run('DELETE FROM extractor_corrections WHERE claim_id = ? AND field = ?', [stagingId, field_path]);
      await db.run(
        `INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id, reasoning)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [stagingId, field_path, original_value, corrected_value, reviewer_id ?? null, noteFinal]
      );
    }

    // Re-read payload after potential edit-write
    const refreshed = await db.get('SELECT payload FROM extraction_staging WHERE id = ?', [stagingId]);
    let refreshedPayload = {};
    try { refreshedPayload = JSON.parse(refreshed.payload || '{}'); } catch { refreshedPayload = {}; }
    const reviewableFields = Object.keys(refreshedPayload).filter(k => !k.startsWith('_') && refreshedPayload[k] !== null && refreshedPayload[k] !== '');

    // Read all corrections for this staging row
    const corrections = await db.all(
      'SELECT field_path, action FROM staging_field_corrections WHERE staging_id = ?',
      [stagingId]
    );
    const correctedSet = new Set(corrections.filter(c => c.action !== 'rejected').map(c => c.field_path));
    const rejectedFields = corrections.filter(c => c.action === 'rejected').map(c => c.field_path);
    const allCorrected = reviewableFields.length > 0 && reviewableFields.every(f => correctedSet.has(f));

    // Auto-promote logic. Per-field ✕ is a SIGNAL for agent feedback, not a
    // row-termination — only auto-approve when all fields are touched AND none
    // are rejected. Whole-row rejection is the partner's explicit action via
    // the bottom Reject button (which uses /api/admin/staging/:id/reject).
    let auto_status = null;
    if (allCorrected && rejectedFields.length === 0) {
      auto_status = 'approved';
      await db.run("UPDATE extraction_staging SET review_status = 'approved', reviewed_at = datetime('now') WHERE id = ?", [stagingId]);
    }

    // Propagate auto-approve to linked live claim (so live claim review_status
    // stays in sync with the staging row after per-field correction).
    if (auto_status === 'approved') {
      const stagingFull = await db.get('SELECT target_table FROM extraction_staging WHERE id = ?', [stagingId]);
      if (stagingFull && ['interactions', 'crop_vulnerabilities', 'attractor_relationship'].includes(stagingFull.target_table)) {
        await db.run(
          "UPDATE claims SET review_status = 'human_verified', reviewed_at = datetime('now') WHERE staging_id = ?",
          [stagingId]
        );
      } else if (stagingFull && stagingFull.target_table === 'entity_trait') {
        await db.run(
          "UPDATE entity_trait_claims SET review_status = 'human_verified', reviewed_at = datetime('now') WHERE staging_id = ?",
          [stagingId]
        );
      }
      // For 'crops' / 'pests_pathogens' (entity enrichment): no live claim row to update.
    }

    res.json({
      ok: true,
      staging_id: stagingId,
      field_path,
      action,
      auto_status,
      reviewable_fields: reviewableFields,
      corrections: corrections.map(c => c.field_path),
      rejected_fields: rejectedFields
    });
  } catch (err) {
    console.error('staging/correct error', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/admin/staging/:id/corrections
 * Returns all per-field correction records for a staging row, plus the row's
 * current reviewable_fields list (payload keys that are non-null/non-empty
 * and don't start with '_').
 */
app.get('/api/admin/staging/:id/corrections', async (req, res) => {
  const stagingId = parseInt(req.params.id, 10);
  if (!stagingId) return res.status(400).json({ error: 'invalid staging id' });
  try {
    const db = await getSqliteDb();
    const staging = await db.get('SELECT payload FROM extraction_staging WHERE id = ?', [stagingId]);
    if (!staging) return res.status(404).json({ error: 'staging row not found' });
    let payload = {};
    try { payload = JSON.parse(staging.payload || '{}'); } catch { payload = {}; }
    const reviewable_fields = Object.keys(payload).filter(k => !k.startsWith('_') && payload[k] !== null && payload[k] !== '');
    const corrections = await db.all(
      'SELECT field_path, action, original_value, corrected_value, note, reviewer_id, created_at FROM staging_field_corrections WHERE staging_id = ? ORDER BY field_path',
      [stagingId]
    );
    res.json({ staging_id: stagingId, reviewable_fields, corrections });
  } catch (err) {
    console.error('staging/corrections error', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * DELETE /api/admin/staging/:id/correct
 * Query or body: { field_path }
 * Removes a per-field correction (lets partner undo their decision).
 * Does NOT auto-revert review_status — once approved/rejected, intent stands.
 */
app.delete('/api/admin/staging/:id/correct', async (req, res) => {
  const stagingId = parseInt(req.params.id, 10);
  const field_path = (req.query.field_path || (req.body && req.body.field_path) || '').trim();
  if (!stagingId || !field_path) return res.status(400).json({ error: 'staging id + field_path required' });
  try {
    const db = await getSqliteDb();
    await db.run('DELETE FROM staging_field_corrections WHERE staging_id = ? AND field_path = ?', [stagingId, field_path]);
    res.json({ ok: true });
  } catch (err) {
    console.error('staging/correct DELETE error', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/admin/staging/bulk
 * Body: { ids: number[], action: 'accept' | 'reject' | 'flag' }
 * Hard cap at 200 ids per request. Single transaction.
 *
 * Maps action → review_status:
 *   accept → 'approved'
 *   reject → 'rejected'
 *   flag   → 'flagged'
 *
 * Mirrors the single-row /staging/:id/approve and /staging/:id/reject
 * handlers: writes review_status + reviewed_at only (no review_note on bulk).
 */
app.post('/api/admin/staging/bulk', async (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (ids.length > 200) {
    return res.status(400).json({ error: 'cap is 200 ids per request' });
  }
  if (!['accept', 'reject', 'flag'].includes(action)) {
    return res.status(400).json({ error: 'action must be accept|reject|flag' });
  }
  // Guard against non-integer or non-positive values (SQL-injection defense)
  const intIds = ids.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);
  if (intIds.length === 0) {
    return res.status(400).json({ error: 'ids must be positive integers' });
  }

  const reviewStatus = action === 'accept' ? 'approved'
                     : action === 'reject' ? 'rejected'
                     : 'flagged';

  try {
    const db = await getSqliteDb();
    const placeholders = intIds.map(() => '?').join(',');
    const result = await db.run(
      `UPDATE extraction_staging
          SET review_status = ?, reviewed_at = datetime('now')
        WHERE id IN (${placeholders})`,
      [reviewStatus, ...intIds]
    );

    // Propagate to linked live claims and entity_trait_claims (idempotent batch update).
    // For 'flag' action reviewStatus='flagged' — no propagation needed.
    if (action === 'accept' || action === 'reject') {
      const claimReviewStatus = action === 'accept' ? 'human_verified' : 'human_rejected';
      await db.run(
        `UPDATE claims SET review_status = ?, reviewed_at = datetime('now') WHERE staging_id IN (${placeholders})`,
        [claimReviewStatus, ...intIds]
      );
      await db.run(
        `UPDATE entity_trait_claims SET review_status = ?, reviewed_at = datetime('now') WHERE staging_id IN (${placeholders})`,
        [claimReviewStatus, ...intIds]
      );
    }

    res.json({ action, review_status: reviewStatus, updated: result.changes ?? intIds.length });
  } catch (err) {
    console.error('staging/bulk error', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 4 — admin review UI for promoted (ai_reviewed) claims.
// Surfaces the live `claims` table for partner spot-check / accept / reject /
// flag-conflict. Read+write to local SQLite; no auth in v0 (admin is local-
// only until partner+tunnel rollout).
// ---------------------------------------------------------------------------

app.get('/admin/review', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-review.html')));

/**
 * GET /api/admin/review/queue
 * Paginated list of claims for human review. Defaults to ai_reviewed.
 * Query: ?status=ai_reviewed&page=1&pageSize=25
 */
app.get('/api/admin/review/queue', async (req, res) => {
  try {
    const _statusRaw = req.query.review_status ?? req.query.status;
    const review_status = _statusRaw !== undefined ? _statusRaw.trim() : 'ai_reviewed';
    const region = (req.query.region || '').trim();
    const sourceId = parseInt(req.query.source_id, 10);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const offset = (page - 1) * pageSize;

    // countsWhere/countsParams: all filters EXCEPT review_status so chip totals
    // stay stable as the partner clicks different status chips.
    const countsWhere = [`c.source_quote IS NOT NULL`, `c.source_quote != ''`];
    const countsParams = [];
    if (region) {
      countsWhere.push(`c.regional_context = ?`);
      countsParams.push(region);
    }
    if (Number.isFinite(sourceId)) {
      countsWhere.push(`c.source_id = ?`);
      countsParams.push(sourceId);
    }
    if (req.query.staging_id) {
      const clause = 'c.staging_id = ?';
      countsWhere.push(clause); countsParams.push(parseInt(req.query.staging_id, 10));
    }
    if (req.query.id) {
      const clause = 'c.id = ?';
      countsWhere.push(clause); countsParams.push(parseInt(req.query.id, 10));
    }

    // where/params: all filters INCLUDING review_status for item + total queries.
    // Empty review_status = no status filter (show all statuses).
    const where = review_status ? [`c.review_status = ?`, ...countsWhere] : [...countsWhere];
    const params = review_status ? [review_status, ...countsParams] : [...countsParams];
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const db = await getSqliteDb();
    const total = (await db.get(`SELECT COUNT(*) AS n FROM claims c ${whereSql}`, params)).n;
    const items = await db.all(
      `SELECT
         c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
         c.effect_direction,
         c.source_quote, c.source_page, c.review_status, c.reviewer_id, c.reviewed_at,
         c.regional_context, c.country, c.subdivision, c.staging_id,
         c.source_id,
         s.title AS source_title, s.authors AS source_authors, s.year AS source_year,
         s.publication AS source_publication, s.url AS source_url, s.license AS source_license,
         s.slug AS source_slug,
         CASE WHEN s.file_path IS NOT NULL AND s.file_path != '' THEN 1 ELSE 0 END AS source_has_pdf,
         e_s.scientific_name AS subject_scientific_name, e_s.common_name AS subject_common_name,
         e_s.slug AS subject_slug, e_s.bio_category AS subject_bio_category,
         e_o.scientific_name AS object_scientific_name, e_o.common_name AS object_common_name,
         e_o.slug AS object_slug, e_o.bio_category AS object_bio_category,
         (SELECT GROUP_CONCAT(critic_name || '|' || verdict || '|' || COALESCE(REPLACE(REPLACE(reasoning, '|', '/'), CHAR(10), ' '), '') || '|' || COALESCE(critic_confidence, '') || '|' || COALESCE(evidence_strength, ''), CHAR(10))
            FROM claim_critic_verdicts ccv
            WHERE ccv.staging_id = c.staging_id
         ) AS critic_verdicts
       FROM claims c
       LEFT JOIN sources  s   ON s.id   = c.source_id
       LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
       LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
       ${whereSql}
       ORDER BY c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    // Aggregate counts per status (excluding review_status filter so chips are stable).
    const countsWhereSql = countsWhere.length ? `WHERE ${countsWhere.join(' AND ')}` : '';
    const countsRows = await db.all(
      `SELECT c.review_status, COUNT(*) AS n
         FROM claims c
         ${countsWhereSql}
         GROUP BY c.review_status`,
      countsParams
    );
    const status_counts = { ai_reviewed: 0, human_verified: 0, human_rejected: 0, disputed: 0 };
    for (const r of countsRows) {
      if (r.review_status in status_counts) status_counts[r.review_status] = r.n;
    }

    res.json({ status: review_status, region, page, pageSize, total, items, status_counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/export/globi.csv
 * Streams a CSV in GloBI's canonical interaction-record format,
 * containing only `human_verified` claims (the strongest trust signal —
 * a human has explicitly approved the AI consensus).
 *
 * Schema reference: https://github.com/jhpoelen/eol-globi-data
 *   sourceTaxonName, interactionTypeName, targetTaxonName,
 *   sourceCitation, referenceCitation, referenceDoi, sourceCitationUrl,
 *   localityName, localityId
 *
 * Filename includes the export timestamp so consecutive exports don't
 * collide in the partner's downloads folder.
 *
 * Query: ?status=human_verified|ai_reviewed (default
 *   human_verified — the strict gate Q5 implies)
 */
app.get('/api/admin/review/export/globi.csv', async (req, res) => {
  try {
    const status = req.query.status || 'human_verified';
    const db = await getSqliteDb();
    const rows = await db.all(`
      SELECT
        c.id, c.interaction_type_globi, c.regional_context,
        c.source_quote, c.source_page,
        s.title    AS source_title,
        s.authors  AS source_authors,
        s.year     AS source_year,
        s.doi      AS source_doi,
        s.url      AS source_url,
        s.license  AS source_license,
        e_s.scientific_name AS subject_scientific_name,
        e_o.scientific_name AS object_scientific_name
      FROM claims c
      LEFT JOIN sources  s   ON s.id   = c.source_id
      LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
      LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
      WHERE c.review_status = ?
        AND c.source_quote IS NOT NULL AND c.source_quote != ''
        AND e_s.scientific_name IS NOT NULL
        AND c.interaction_type_globi IS NOT NULL
      ORDER BY c.id ASC
    `, [status]);

    const HEADER = [
      'sourceTaxonName',
      'interactionTypeName',
      'targetTaxonName',
      'localityName',
      'sourceCitation',
      'referenceCitation',
      'referenceDoi',
      'sourceCitationUrl',
      'sourceQuote',
      'sourcePage',
      'agroEcoClaimId'
    ];
    function csvEscape(v) {
      if (v == null) return '';
      const s = String(v);
      if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }
    const lines = [HEADER.join(',')];
    for (const r of rows) {
      const refCitation = [r.source_authors, r.source_year ? `(${r.source_year})` : null, r.source_title].filter(Boolean).join(' ');
      const row = [
        r.subject_scientific_name,
        r.interaction_type_globi,
        r.object_scientific_name || '',
        r.regional_context || '',
        r.source_title || '',
        refCitation,
        r.source_doi || '',
        r.source_url || '',
        r.source_quote,
        r.source_page || '',
        `agroeco-claim-${r.id}`
      ];
      lines.push(row.map(csvEscape).join(','));
    }
    const csv = lines.join('\n') + '\n';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agroeco-globi-${status}-${ts}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/export/trefle.json
 * Exports plant entities backed by CC-licensed sources (Q5: license-
 * compatible with Trefle's CC-BY-SA). One JSON object per entity,
 * keyed by id, containing scientific_name + the Trefle-compatible
 * environmental + identity field set.
 *
 * Strict license filter: only entities involved in claims from a
 * source with license LIKE 'CC%'. Unlicensed/proprietary sources are
 * excluded.
 */
app.get('/api/admin/review/export/trefle.json', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const rows = await db.all(`
      SELECT DISTINCT e.*
      FROM entities e
      WHERE e.bio_category = 'plantae'
        AND e.scientific_name IS NOT NULL
        AND e.slug IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM claims c
          JOIN sources s ON s.id = c.source_id
          WHERE (c.subject_entity_id = e.id OR c.object_entity_id = e.id)
            AND c.review_status = 'human_verified'
            AND s.license LIKE 'CC%'
        )
      ORDER BY e.id ASC
    `);
    const items = rows.map(e => ({
      id: e.id,
      slug: e.slug,
      scientific_name: e.scientific_name,
      common_name: e.common_name,
      family: e.family,
      family_common_name: e.family_common_name,
      genus: e.genus,
      synonyms: e.synonyms,
      // Trefle-compatible environmental fields
      growth: {
        ph_minimum: e.ph_min,
        ph_maximum: e.ph_max,
        soil_humidity: e.soil_humidity,
        soil_texture: e.soil_texture,
        light: e.light_requirement,
        atmospheric_humidity: e.atmospheric_humidity,
        minimum_temperature: e.min_temp_c,
        maximum_temperature: e.max_temp_c,
        minimum_root_depth: e.min_root_depth_cm,
        days_to_harvest: e.days_to_harvest,
        row_spacing_cm: e.row_spacing_cm,
        spread_cm: e.spread_cm,
        growth_months: e.growth_months,
        bloom_months: e.bloom_months,
        fruit_months: e.fruit_months
      },
      specifications: {
        average_height_cm: e.average_height_cm,
        maximum_height_cm: e.maximum_height_cm,
        growth_form: e.growth_form,
        growth_habit: e.growth_habit,
        growth_rate: e.growth_rate,
        ligneous_type: e.ligneous_type,
        shape_and_orientation: e.shape_and_orientation,
        toxicity: e.toxicity
      },
      vegetable: !!e.vegetable,
      edible: !!e.edible,
      edible_part: e.edible_part,
      native_zones: e.native_zones,
      introduced_zones: e.introduced_zones,
      duration: e.duration,
      image_url: e.image_url,
      // AEDIN-specific extension (Trefle ignores; we keep for our records)
      _agroeco: {
        primary_role: e.primary_role,
        crop_type: e.crop_type,
        agroeco_functions: e.agroeco_functions
      }
    }));
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agroeco-trefle-export-${ts}.json"`);
    res.send(JSON.stringify({ exported_at: new Date().toISOString(), count: items.length, items }, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PDF upload (Phase 4 Ingest > Upload tab) ─────────────────────────────
// Accepts a multipart upload, saves the file to the appropriate
// literature/ subdirectory based on source_type, and creates an
// extraction_queue row. Server-side extraction is deferred (per Q3 of
// project_admin_restructure_decisions.md); the owner runs the existing
// CLI scripts (pdf-chunk.js, stage-from-json.js) to actually process
// queued files.
const multer = require('multer');
const fs = require('fs');
const LITERATURE_ROOT = path.join(__dirname, '..', 'literature');
const UPLOAD_TMP = path.join(LITERATURE_ROOT, '_uploads_tmp');
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });
// No filesize limit per Q2.
const upload = multer({ dest: UPLOAD_TMP });

function sanitizeFilename(original) {
  const lower = (original || 'upload.pdf').toLowerCase();
  const cleaned = lower.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  // Always preserve `.pdf` extension if present in the lowercased name.
  return cleaned || `upload-${Date.now()}.pdf`;
}

function destSubdir(sourceType) {
  switch ((sourceType || '').toLowerCase()) {
    case 'book': return 'books';
    case 'extension': case 'extension_bulletin': return 'extension';
    case 'paper': case 'preprint': case 'thesis': case 'report': default:
      return 'papers';
  }
}

/**
 * POST /api/admin/review/upload
 * Multipart fields:
 *   file: the PDF
 *   source_type: book | paper | extension | report | preprint | thesis | website
 *   title (optional): if omitted, defaults to filename
 *   uploader (optional): freetext name for sources.added_by
 *   source_id (optional): existing source to associate with; if omitted a
 *     fresh row is left for extract-source-cli.js to create when
 *     extraction runs
 *
 * Response: { queue_id, file_path, sanitized_name }
 */
app.post('/api/admin/review/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded (form field name: "file")' });
    const sourceType = (req.body.source_type || 'paper').trim();
    const title = (req.body.title || req.file.originalname || 'Untitled upload').trim();
    const uploader = (req.body.uploader || 'owner').trim() || 'owner';
    const subdir = destSubdir(sourceType);
    const safeName = sanitizeFilename(req.file.originalname);
    const targetDir = path.join(LITERATURE_ROOT, subdir);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    // Avoid collisions: if file with this name already exists, prefix epoch.
    let finalPath = path.join(targetDir, safeName);
    if (fs.existsSync(finalPath)) {
      finalPath = path.join(targetDir, `${Date.now()}-${safeName}`);
    }
    fs.renameSync(req.file.path, finalPath);

    const db = await getSqliteDb();
    // Create a placeholder source row so it shows up in the source-picker
    // dropdown right away with added_by populated. extract-source.js will
    // upsert into this row when it runs (matched on file_path).
    const sourceResult = await db.run(
      `INSERT INTO sources (title, source_type, file_path, added_by, ingested_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [title, sourceType, finalPath, uploader]
    );
    const sourceId = sourceResult.lastID;
    // Then queue the extraction job.
    const queueResult = await db.run(
      `INSERT INTO extraction_queue (file_path, source_type, source_id, priority, status, added_at)
       VALUES (?, ?, ?, 5, 'pending', datetime('now'))`,
      [finalPath, sourceType, sourceId]
    );
    res.json({
      queue_id: queueResult.lastID,
      source_id: sourceId,
      file_path: finalPath,
      sanitized_name: path.basename(finalPath)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/literature/:source_id/pdf
 * Stream the PDF file for a given source. Returns the raw PDF bytes so the
 * admin review panel can embed an <iframe> snapshot at a specific page.
 * Returns 404 if the source has no file_path or the file is missing on disk.
 */
app.get('/api/admin/literature/:source_id/pdf', async (req, res) => {
  try {
    const sourceId = parseInt(req.params.source_id, 10);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      return res.status(400).json({ error: 'invalid source_id' });
    }
    const db = await getSqliteDb();
    const row = await db.get('SELECT file_path FROM sources WHERE id = ?', [sourceId]);
    if (!row || !row.file_path) {
      return res.status(404).json({ error: 'no PDF on file for this source' });
    }
    let abs = row.file_path;
    if (!path.isAbsolute(abs)) abs = path.join(__dirname, '..', abs);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: 'PDF file missing on disk' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    console.error('literature PDF error', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/admin/review/ingest-sources
 * List of sources for the Ingest tab's source-picker dropdown. Each row
 * carries the source identity (id, title, slug, year, authors), the
 * uploader (sources.added_by, default 'owner' if NULL), the ingestion
 * date (sources.ingested_at), and queue/staging counts so the partner
 * sees how much there is to review for each.
 *
 * Sorted with most-recently-ingested first.
 */
app.get('/api/admin/review/ingest-sources', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const items = await db.all(`
      SELECT
        s.id, s.title, s.slug, s.year, s.authors, s.source_type,
        COALESCE(s.added_by, 'owner') AS added_by,
        s.ingested_at AS added_at,
        s.ingested_at,
        COALESCE(es_agg.staging_total,    0) AS staging_total,
        COALESCE(es_agg.staging_total,    0) AS staging_count,
        COALESCE(es_agg.staging_pending,  0) AS staging_pending,
        COALESCE(c_agg.claims_total,      0) AS claims_total,
        COALESCE(c_agg.claims_total,      0) AS claim_count,
        COALESCE(c_agg.claims_pending,    0) AS claims_pending,
        COALESCE(c_agg.claims_pending,    0) AS verified_claim_count,
        COALESCE(et_agg.entity_traits_total,   0) AS entity_traits_total,
        COALESCE(et_agg.entity_traits_pending, 0) AS entity_traits_pending,
        COALESCE(c_agg.entities_count,    0) AS entities_count
      FROM sources s
      LEFT JOIN (
        SELECT source_id,
               COUNT(*) AS staging_total,
               SUM(CASE WHEN review_status='pending' OR ai_vouch_status='pending' THEN 1 ELSE 0 END) AS staging_pending
        FROM extraction_staging
        GROUP BY source_id
      ) es_agg ON es_agg.source_id = s.id
      LEFT JOIN (
        SELECT source_id,
               COUNT(*) AS claims_total,
               SUM(CASE WHEN review_status='ai_reviewed' THEN 1 ELSE 0 END) AS claims_pending,
               COUNT(DISTINCT subject_entity_id) + COUNT(DISTINCT object_entity_id) AS entities_count
        FROM claims
        GROUP BY source_id
      ) c_agg ON c_agg.source_id = s.id
      LEFT JOIN (
        SELECT source_id,
               COUNT(*) AS entity_traits_total,
               SUM(CASE WHEN review_status IN ('unreviewed','ai_vouched','ai_reviewed') THEN 1 ELSE 0 END) AS entity_traits_pending
        FROM entity_trait_claims
        GROUP BY source_id
      ) et_agg ON et_agg.source_id = s.id
      ORDER BY COALESCE(s.ingested_at, s.created_at) DESC, s.id DESC
    `);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/regions
 * Distinct regional_context values across verified claims, with counts.
 * Used to populate the region-filter dropdown in the admin spreadsheet.
 */
app.get('/api/admin/review/regions', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const items = await db.all(`
      SELECT regional_context AS region, COUNT(*) AS n
      FROM claims
      WHERE review_status = 'ai_reviewed'
        AND source_quote IS NOT NULL AND source_quote != ''
        AND regional_context IS NOT NULL AND regional_context != ''
      GROUP BY regional_context
      ORDER BY n DESC
      LIMIT 100
    `);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Note: GET /api/admin/review/:id (single-claim detail) was removed because
// (a) the frontend doesn't call it — queue results already carry full row
// data — and (b) it conflicted with the /entities and /sources routes via
// Express 5's stricter path matching (the path-to-regexp v8+ no longer
// supports inline numeric constraints like :id(\d+)). If single-claim
// detail is needed in v1, re-add it AFTER the entities/sources routes so
// the literal paths match first.

async function applyReviewAction(req, res, newStatus) {
  try {
    const db = await getSqliteDb();
    const { reviewer = null } = req.body || {};
    const result = await db.run(
      `UPDATE claims SET review_status = ?, reviewer_id = ?, reviewed_at = datetime('now') WHERE id = ?`,
      [newStatus, reviewer, req.params.id]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Claim not found' });
    res.json({ id: parseInt(req.params.id, 10), review_status: newStatus, reviewer_id: reviewer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/admin/review/entities
 * List entities ingested from literature, joined with their verified-claim
 * count. Default filter: only entities with ≥1 verified claim (the ones the
 * partner can usefully audit). Pass scope=all to see the full 194K table.
 *
 * Query: ?scope=verified|all&bio_category=&search=&page=1&pageSize=50
 */
app.get('/api/admin/review/entities', async (req, res) => {
  try {
    const scope = req.query.scope === 'all' ? 'all' : 'verified';
    const bio_category = (req.query.bio_category || '').trim();
    const search = (req.query.search || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;

    // Pre-aggregate verified-claim counts per entity via a CTE. Each verified
    // claim contributes 1 to its subject and 1 to its object — the UNION ALL
    // + outer SUM handles both endpoints in a single pass over claims rather
    // than the naive O(entities × claims) subquery per row.
    const cteSql = `
      WITH ec AS (
        SELECT entity_id, SUM(cnt) AS verified_claim_count FROM (
          SELECT subject_entity_id AS entity_id, COUNT(*) AS cnt
            FROM claims
            WHERE review_status = 'ai_reviewed'
              AND source_quote IS NOT NULL AND source_quote != ''
              AND subject_entity_id IS NOT NULL
            GROUP BY subject_entity_id
          UNION ALL
          SELECT object_entity_id AS entity_id, COUNT(*) AS cnt
            FROM claims
            WHERE review_status = 'ai_reviewed'
              AND source_quote IS NOT NULL AND source_quote != ''
              AND object_entity_id IS NOT NULL
            GROUP BY object_entity_id
        )
        GROUP BY entity_id
      )`;

    const needs_dedup = (req.query.needs_dedup || '').trim();
    const region = (req.query.region || '').trim();
    const completeness = (req.query.completeness || '').trim();
    const sourceIdFilter = parseInt(req.query.source_id, 10);

    // Two accumulators: `where` drives items + total; `countsWhere` drives the
    // completeness_counts aggregate (excludes the completeness filter itself so
    // counts are stable across filter clicks).
    const where = [];
    const countsWhere = [];
    const params = [];
    const countsParams = [];

    if (bio_category) {
      where.push('e.bio_category = ?'); params.push(bio_category);
      countsWhere.push('e.bio_category = ?'); countsParams.push(bio_category);
    }
    if (needs_dedup === '1') {
      where.push('e.needs_dedup = 1');
      countsWhere.push('e.needs_dedup = 1');
    }
    if (needs_dedup === '0') {
      where.push('(e.needs_dedup IS NULL OR e.needs_dedup = 0)');
      countsWhere.push('(e.needs_dedup IS NULL OR e.needs_dedup = 0)');
    }
    if (region) {
      const regionClause = `EXISTS (
        SELECT 1 FROM claims rc
        WHERE (rc.subject_entity_id = e.id OR rc.object_entity_id = e.id)
          AND rc.review_status = 'ai_reviewed'
          AND rc.regional_context = ?
      )`;
      where.push(regionClause); params.push(region);
      countsWhere.push(regionClause); countsParams.push(region);
    }
    if (Number.isFinite(sourceIdFilter)) {
      // Filter to entities appearing in at least one claim from this source.
      // Includes claims of any review_status — Ingest > Entities should
      // surface entities from the in-flight source whether or not those
      // claims have been verified yet.
      const sourceClause = `EXISTS (
        SELECT 1 FROM claims rc
        WHERE (rc.subject_entity_id = e.id OR rc.object_entity_id = e.id)
          AND rc.source_id = ?
      )`;
      where.push(sourceClause); params.push(sourceIdFilter);
      countsWhere.push(sourceClause); countsParams.push(sourceIdFilter);
    }
    if (search) {
      const searchClause = '(e.scientific_name LIKE ? OR e.common_name LIKE ? OR e.slug LIKE ?)';
      const s = `%${search}%`;
      where.push(searchClause); params.push(s, s, s);
      countsWhere.push(searchClause); countsParams.push(s, s, s);
    }
    if (req.query.scientific_name) {
      const clause = 'e.scientific_name = ? COLLATE NOCASE';
      where.push(clause); params.push(req.query.scientific_name);
      countsWhere.push(clause); countsParams.push(req.query.scientific_name);
    }
    if (req.query.id) {
      const clause = 'e.id = ?';
      where.push(clause); params.push(parseInt(req.query.id, 10));
      countsWhere.push(clause); countsParams.push(parseInt(req.query.id, 10));
    }

    // completeness filter goes into `where` only — not countsWhere — so that
    // completeness_counts reflects the full (non-filtered) breakdown.
    if (completeness === 'incomplete') {
      where.push(INCOMPLETE_PREDICATE);
    } else if (completeness === 'complete') {
      where.push(`NOT ${INCOMPLETE_PREDICATE}`);
    }

    const join = scope === 'verified' ? 'JOIN ec ON ec.entity_id = e.id' : 'LEFT JOIN ec ON ec.entity_id = e.id';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countsWhereSql = countsWhere.length ? `WHERE ${countsWhere.join(' AND ')} AND ` : 'WHERE ';

    const db = await getSqliteDb();
    const total = (await db.get(
      `${cteSql} SELECT COUNT(*) AS n FROM entities e ${join} ${whereSql}`,
      params
    )).n;
    const items = await db.all(
      `${cteSql}
       SELECT
         e.id, e.slug, e.scientific_name, e.common_name, e.family, e.genus,
         e.taxonomy_path, e.bio_category, e.primary_role, e.crop_type, e.needs_dedup,
         COALESCE(ec.verified_claim_count, 0) AS verified_claim_count,
         (SELECT GROUP_CONCAT(DISTINCT regional_context) FROM (
            SELECT rc.regional_context
            FROM claims rc
            WHERE (rc.subject_entity_id = e.id OR rc.object_entity_id = e.id)
              AND rc.review_status = 'ai_reviewed'
              AND rc.regional_context IS NOT NULL AND rc.regional_context != ''
            ORDER BY 1
          )) AS regions
       FROM entities e
       ${join}
       ${whereSql}
       ORDER BY verified_claim_count DESC, e.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    // Completeness counts — stable across filter clicks because countsWhere
    // excludes the completeness clause.
    const incompleteRow = await db.get(
      `SELECT COUNT(*) AS n FROM entities e ${countsWhereSql}${INCOMPLETE_PREDICATE}`,
      countsParams
    );
    const completeRow = await db.get(
      `SELECT COUNT(*) AS n FROM entities e ${countsWhereSql}NOT ${INCOMPLETE_PREDICATE}`,
      countsParams
    );
    const completeness_counts = {
      incomplete: incompleteRow ? incompleteRow.n : 0,
      complete:   completeRow   ? completeRow.n   : 0
    };

    res.json({ scope, bio_category, region, search, page, pageSize, total, items, completeness_counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/entities/:id
 * Full entity row — all 100+ columns. Used by the admin's environmental
 * detail expand panel on the Entities tab. Cheap (single row read,
 * indexed by id).
 */
app.get('/api/admin/review/entities/:id', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const item = await db.get(`SELECT * FROM entities WHERE id = ? LIMIT 1`, [req.params.id]);
    if (!item) return res.status(404).json({ error: 'entity not found' });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/sources
 * List sources ingested from literature, with their verified-claim count.
 *
 * Query: ?source_type=&search=&page=1&pageSize=50
 */
app.get('/api/admin/review/sources', async (req, res) => {
  try {
    const source_type = (req.query.source_type || '').trim();
    const search = (req.query.search || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];
    if (source_type) { where.push('s.source_type = ?'); params.push(source_type); }
    if (search) {
      where.push('(s.title LIKE ? OR s.authors LIKE ? OR s.slug LIKE ?)');
      const q = `%${search}%`; params.push(q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Pre-aggregate per-source claim counts in a single pass.
    const cteSql = `
      WITH sc AS (
        SELECT source_id, COUNT(*) AS verified_claim_count
          FROM claims
          WHERE review_status = 'ai_reviewed'
            AND source_quote IS NOT NULL AND source_quote != ''
          GROUP BY source_id
      )`;

    const db = await getSqliteDb();
    const total = (await db.get(`SELECT COUNT(*) AS n FROM sources s ${whereSql}`, params)).n;
    const items = await db.all(
      `${cteSql}
       SELECT
         s.id, s.slug, s.title, s.authors, s.year, s.publication,
         s.source_type, s.url, s.doi, s.license, s.access_level,
         COALESCE(sc.verified_claim_count, 0) AS verified_claim_count
       FROM sources s
       LEFT JOIN sc ON sc.source_id = s.id
       ${whereSql}
       ORDER BY verified_claim_count DESC, s.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ source_type, search, page, pageSize, total, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/staging
 * Paginated staging rows (pre-promotion). Read-only — actions on staging
 * rows still go through the existing /api/admin/staging/:id/{approve,reject}
 * endpoints. This endpoint is for surfacing the queue, not mutating it.
 *
 * Query: ?ai_vouch_status=&review_status=&target_table=&search=&scope=&page=1&pageSize=50
 *
 * scope values:
 *   '' (default)       — all rows for source (existing behaviour)
 *   'unreviewed'       — review_status='pending' OR ai_vouch_status='pending'
 *   'claim_pending'    — promoted rows whose live claim is ai_reviewed
 *   'trait_pending'    — promoted rows whose entity_trait_claim is unreviewed/ai_vouched/ai_reviewed
 *   'entity_attention' — crops/pests_pathogens rows whose matched entity is incomplete
 */
app.get('/api/admin/review/staging', async (req, res) => {
  try {
    const ai_vouch_status = (req.query.ai_vouch_status || '').trim();
    const review_status = (req.query.review_status || '').trim();
    const target_table = (req.query.target_table || '').trim();
    const search = (req.query.search || '').trim();
    const scope = (req.query.scope || '').trim();
    const sourceId = parseInt(req.query.source_id, 10);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;

    // Scope JOIN and WHERE clause (added to both main and counts queries).
    let scopeJoin = '';
    let scopeWhere = '';
    if (scope === 'unreviewed') {
      scopeWhere = "(es.review_status = 'pending' OR es.ai_vouch_status = 'pending')";
    } else if (scope === 'claim_pending') {
      scopeJoin = ' LEFT JOIN claims c ON c.staging_id = es.id ';
      scopeWhere = "es.target_table IN ('interactions','crop_vulnerabilities','attractor_relationship') AND " +
                  "(es.review_status = 'pending' OR es.ai_vouch_status = 'pending' OR c.review_status = 'ai_reviewed')";
    } else if (scope === 'trait_pending') {
      scopeJoin = ' LEFT JOIN entity_trait_claims etc ON etc.staging_id = es.id ';
      scopeWhere = "es.target_table = 'entity_trait' AND " +
                  "(es.review_status = 'pending' OR es.ai_vouch_status = 'pending' OR " +
                  "etc.review_status IN ('unreviewed','ai_vouched','ai_reviewed'))";
    } else if (scope === 'entity_attention') {
      scopeJoin = " LEFT JOIN entities e ON LOWER(e.scientific_name) = LOWER(json_extract(es.payload, '$.scientific_name')) ";
      scopeWhere = `es.target_table IN ('crops','pests_pathogens') AND ` +
                  `(es.review_status = 'pending' OR es.ai_vouch_status = 'pending' OR ${INCOMPLETE_PREDICATE})`;
    }

    const where = [];
    const params = [];
    const countsWhere = [];
    const countsParams = [];

    if (scopeWhere) {
      where.push(scopeWhere);
      countsWhere.push(scopeWhere);
    }

    // Each filter besides ai_vouch_status goes into both accumulators so
    // verdict_counts stays stable as the partner clicks through chips.
    if (review_status) {
      const clause = 'es.review_status = ?';
      where.push(clause); params.push(review_status);
      countsWhere.push(clause); countsParams.push(review_status);
    }
    if (target_table) {
      const clause = 'es.target_table = ?';
      where.push(clause); params.push(target_table);
      countsWhere.push(clause); countsParams.push(target_table);
    }
    if (Number.isFinite(sourceId)) {
      const clause = 'es.source_id = ?';
      where.push(clause); params.push(sourceId);
      countsWhere.push(clause); countsParams.push(sourceId);
    }
    if (search) {
      const clause = "(es.payload LIKE ? OR s.title LIKE ?)";
      const q = `%${search}%`;
      where.push(clause); params.push(q, q);
      countsWhere.push(clause); countsParams.push(q, q);
    }

    // ai_vouch_status filter: ONLY on the items/total query, NOT on counts
    if (ai_vouch_status) { where.push('es.ai_vouch_status = ?'); params.push(ai_vouch_status); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countsWhereSql = countsWhere.length ? `WHERE ${countsWhere.join(' AND ')}` : '';

    const db = await getSqliteDb();
    const total = (await db.get(
      `SELECT COUNT(*) AS n FROM extraction_staging es LEFT JOIN sources s ON s.id = es.source_id${scopeJoin} ${whereSql}`,
      params
    )).n;
    const rows = await db.all(
      `SELECT
         es.id, es.target_table, es.review_status, es.ai_vouch_status, es.ai_vouch_note,
         es.created_at, es.payload, es.source_id,
         s.title AS source_title, s.slug AS source_slug, s.year AS source_year,
         CASE WHEN s.file_path IS NOT NULL AND s.file_path != '' THEN 1 ELSE 0 END AS source_has_pdf,
         (SELECT GROUP_CONCAT(
            cv.critic_name || '|' || cv.verdict || '|' ||
            COALESCE(REPLACE(REPLACE(cv.reasoning, '|', '/'), CHAR(10), ' '), '') || '|' ||
            COALESCE(cv.critic_confidence, '') || '|' ||
            COALESCE(cv.evidence_strength, ''),
            CHAR(10)
          )
          FROM claim_critic_verdicts cv
          WHERE cv.staging_id = es.id) AS critic_verdicts
       FROM extraction_staging es
       LEFT JOIN sources s ON s.id = es.source_id${scopeJoin}
       ${whereSql}
       ORDER BY es.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    const items = rows.map(r => {
      let p = {};
      try { p = JSON.parse(r.payload || '{}'); } catch {}
      return {
        id: r.id,
        target_table: r.target_table,
        review_status: r.review_status,
        ai_vouch_status: r.ai_vouch_status,
        ai_vouch_note: r.ai_vouch_note,
        created_at: r.created_at,
        source_id: r.source_id || null,
        source_has_pdf: r.source_has_pdf === 1,
        source_title: r.source_title,
        source_slug: r.source_slug,
        source_year: r.source_year,
        critic_verdicts: r.critic_verdicts || null,
        // Best-effort summary fields parsed out of the JSON payload
        subject: p.subject_crop || p.crop || p.scientific_name || null,
        object: p.object_crop || p.pest_scientific_name || p.pest_common_name || null,
        relationship: p.interaction_type || p.damage_type || null,
        confidence_score: p.confidence_score ?? null,
        source_quote: p.source_quote || null,
        source_page: p.source_page || null,
        extracted_claim: p.extracted_claim || null,
        payload: r.payload || null,
        promoted_destination: null  // filled in below for promoted rows
      };
    });

    // Resolve promoted_destination — batched by target_table type (at most 3 round-trips total).
    const claimsLikeIds = items
      .filter(it => it.review_status === 'promoted' &&
        ['interactions', 'crop_vulnerabilities', 'attractor_relationship'].includes(it.target_table))
      .map(it => it.id);

    const traitIds = items
      .filter(it => it.review_status === 'promoted' && it.target_table === 'entity_trait')
      .map(it => it.id);

    const entityEnrichRows = items
      .filter(it => it.review_status === 'promoted' &&
        ['crops', 'pests_pathogens'].includes(it.target_table));

    const claimsMap = {};
    if (claimsLikeIds.length) {
      const placeholders = claimsLikeIds.map(() => '?').join(',');
      const rows = await db.all(`SELECT id, staging_id FROM claims WHERE staging_id IN (${placeholders})`, claimsLikeIds);
      for (const r of rows) claimsMap[r.staging_id] = r.id;
    }

    const traitMap = {};
    if (traitIds.length) {
      const placeholders = traitIds.map(() => '?').join(',');
      const rows = await db.all(`SELECT id, staging_id FROM entity_trait_claims WHERE staging_id IN (${placeholders})`, traitIds);
      for (const r of rows) traitMap[r.staging_id] = r.id;
    }

    const sciNames = new Set();
    const itemSci = new Map();
    for (const it of entityEnrichRows) {
      let payload; try { payload = JSON.parse(it.payload || '{}'); } catch { payload = {}; }
      const sci = payload.scientific_name || payload.crop;
      if (sci) { sciNames.add(sci); itemSci.set(it.id, sci); }
    }
    const entityMap = {};
    if (sciNames.size) {
      const arr = Array.from(sciNames);
      const placeholders = arr.map(() => '?').join(',');
      const rows = await db.all(
        `SELECT id, scientific_name FROM entities WHERE scientific_name IN (${placeholders}) COLLATE NOCASE`,
        arr
      );
      for (const r of rows) entityMap[r.scientific_name.toLowerCase()] = r.id;
    }

    for (const it of items) {
      if (it.review_status !== 'promoted') { it.promoted_destination = null; continue; }
      if (claimsMap[it.id] != null) {
        it.promoted_destination = { table: 'claims', id: claimsMap[it.id] };
      } else if (traitMap[it.id] != null) {
        it.promoted_destination = { table: 'entity_traits', id: traitMap[it.id] };
      } else if (itemSci.has(it.id)) {
        const eid = entityMap[itemSci.get(it.id).toLowerCase()];
        it.promoted_destination = eid != null ? { table: 'entities', id: eid } : null;
      } else {
        it.promoted_destination = null;
      }
    }
    // verdict_counts: include scopeJoin so cross-table scope filters (claim_pending etc.)
    // don't reference columns from un-joined tables and crash the query.
    const countsRows = await db.all(
      `SELECT COALESCE(es.ai_vouch_status, 'pending') AS verdict, COUNT(*) AS n
         FROM extraction_staging es
         LEFT JOIN sources s ON s.id = es.source_id${scopeJoin}
         ${countsWhereSql}
         GROUP BY COALESCE(es.ai_vouch_status, 'pending')`,
      countsParams
    );
    const verdict_counts = { plausible: 0, uncertain: 0, implausible: 0, out_of_scope: 0, pending: 0 };
    for (const r of countsRows) {
      if (r.verdict in verdict_counts) verdict_counts[r.verdict] = r.n;
    }

    // scope_counts: 4 independent COUNT queries (one per scope), always relative to
    // the current source_id. Used by frontend scope-chips to show cross-scope totals.
    async function countScope(sc) {
      if (!Number.isFinite(sourceId)) return 0;
      let sql, scParams;
      if (sc === 'unreviewed') {
        sql = `SELECT COUNT(*) AS n FROM extraction_staging es
               WHERE es.source_id = ?
                 AND (es.review_status = 'pending' OR es.ai_vouch_status = 'pending')`;
        scParams = [sourceId];
      } else if (sc === 'claim_pending') {
        sql = `SELECT COUNT(*) AS n FROM extraction_staging es
               LEFT JOIN claims c ON c.staging_id = es.id
               WHERE es.source_id = ?
                 AND es.target_table IN ('interactions','crop_vulnerabilities','attractor_relationship')
                 AND (es.review_status = 'pending' OR es.ai_vouch_status = 'pending' OR c.review_status = 'ai_reviewed')`;
        scParams = [sourceId];
      } else if (sc === 'trait_pending') {
        sql = `SELECT COUNT(*) AS n FROM extraction_staging es
               LEFT JOIN entity_trait_claims etc ON etc.staging_id = es.id
               WHERE es.source_id = ?
                 AND es.target_table = 'entity_trait'
                 AND (es.review_status = 'pending' OR es.ai_vouch_status = 'pending'
                      OR etc.review_status IN ('unreviewed','ai_vouched','ai_reviewed'))`;
        scParams = [sourceId];
      } else if (sc === 'entity_attention') {
        sql = `SELECT COUNT(*) AS n FROM extraction_staging es
               LEFT JOIN entities e ON LOWER(e.scientific_name) = LOWER(json_extract(es.payload, '$.scientific_name'))
               WHERE es.source_id = ?
                 AND es.target_table IN ('crops','pests_pathogens')
                 AND (es.review_status = 'pending' OR es.ai_vouch_status = 'pending' OR ${INCOMPLETE_PREDICATE})`;
        scParams = [sourceId];
      } else {
        return 0;
      }
      const row = await db.get(sql, scParams);
      return row ? row.n : 0;
    }
    const scope_counts = {
      unreviewed:       await countScope('unreviewed'),
      claim_pending:    await countScope('claim_pending'),
      trait_pending:    await countScope('trait_pending'),
      entity_attention: await countScope('entity_attention')
    };

    res.json({ ai_vouch_status, review_status, target_table, search, scope, page, pageSize, total, items, verdict_counts, scope_counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/queue-extraction
 * Paginated extraction-queue (PDF ingestion pipeline) rows. Convenience
 * wrapper around existing /api/admin/queue but with pagination + total.
 *
 * Query: ?status=&page=1&pageSize=50
 */
app.get('/api/admin/review/queue-extraction', async (req, res) => {
  try {
    const status = (req.query.status || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;
    const where = status ? 'WHERE eq.status = ?' : '';
    const params = status ? [status] : [];

    const db = await getSqliteDb();
    const total = (await db.get(
      `SELECT COUNT(*) AS n FROM extraction_queue eq ${where}`,
      params
    )).n;
    const items = await db.all(
      `SELECT eq.id, eq.url, eq.file_path, eq.source_type, eq.priority, eq.status,
              eq.error_message, eq.added_at, eq.started_at, eq.completed_at,
              s.title AS source_title, s.slug AS source_slug
       FROM extraction_queue eq
       LEFT JOIN sources s ON s.id = eq.source_id
       ${where}
       ORDER BY eq.added_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ status, page, pageSize, total, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/pending-crops
 * Paginated pending-crops queue (entities awaiting Trefle submission).
 *
 * Query: ?submitted=0|1&search=&page=1&pageSize=50
 */
app.get('/api/admin/review/pending-crops', async (req, res) => {
  try {
    const submitted = req.query.submitted;
    const search = (req.query.search || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];
    if (submitted === '0' || submitted === '1') {
      where.push('pc.trefle_submitted = ?'); params.push(parseInt(submitted, 10));
    }
    if (search) {
      where.push('(pc.scientific_name LIKE ? OR pc.common_name LIKE ?)');
      const q = `%${search}%`; params.push(q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const db = await getSqliteDb();
    const total = (await db.get(
      `SELECT COUNT(*) AS n FROM pending_crops pc ${whereSql}`,
      params
    )).n;
    const items = await db.all(
      `SELECT pc.id, pc.scientific_name, pc.common_name, pc.region_context,
              pc.trefle_submitted, pc.created_at,
              s.title AS source_title, s.slug AS source_slug
       FROM pending_crops pc
       LEFT JOIN sources s ON s.id = pc.source_id
       ${whereSql}
       ORDER BY pc.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ submitted: submitted ?? '', search, page, pageSize, total, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/review/bulk
 * Body: { ids: [number, ...], action: 'accept'|'reject'|'flag', reviewer? }
 *
 * Apply the same review action to many claims in one transaction. Server
 * caps the batch at 500 ids per request. Returns the count of rows
 * actually updated (zero if all the ids were already in the target state
 * or didn't exist).
 */
app.post('/api/admin/review/bulk', async (req, res) => {
  try {
    const { ids = [], action, reviewer = null } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
    if (ids.length > 500) return res.status(400).json({ error: 'batch capped at 500 ids' });
    const map = { accept: 'human_verified', reject: 'human_rejected', flag: 'disputed' };
    const newStatus = map[action];
    if (!newStatus) return res.status(400).json({ error: `action must be one of: ${Object.keys(map).join(', ')}` });
    const intIds = ids.map(n => parseInt(n, 10)).filter(Number.isFinite);
    if (intIds.length === 0) return res.status(400).json({ error: 'no valid integer ids' });
    const placeholders = intIds.map(() => '?').join(',');
    const db = await getSqliteDb();
    const result = await db.run(
      `UPDATE claims SET review_status = ?, reviewer_id = ?, reviewed_at = datetime('now')
       WHERE id IN (${placeholders})`,
      [newStatus, reviewer, ...intIds]
    );
    res.json({ action, review_status: newStatus, requested: intIds.length, updated: result.changes ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/admin/review/claims/:id
 * Body: any subset of { interaction_type_raw, interaction_type_globi,
 *                       interaction_category, effect_direction, source_page,
 *                       regional_context, country, subdivision, source_quote }
 *       plus optional { reviewer? } (recorded as the editor)
 *       plus optional { reasoning? } (recorded with the audit trail)
 *
 * Each field changed is recorded as a row in extractor_corrections. The
 * claim's review_status is set to 'edited' (downstream of any prior
 * verified state — corrections always supersede consensus).
 *
 * Identity fields (subject_entity_id, object_entity_id, source_id) are
 * intentionally NOT editable here — those need a deliberate
 * entity-picker UX with autocomplete that doesn't yet exist.
 */
app.patch('/api/admin/review/claims/:id', async (req, res) => {
  try {
    const allowed = [
      'interaction_type_raw', 'interaction_type_globi', 'interaction_category',
      'effect_direction', 'source_page', 'regional_context',
      'country', 'subdivision', 'source_quote'
    ];
    const { reviewer = null, reasoning = null, ...fields } = req.body || {};
    const updates = [];
    const params = [];
    const auditRows = [];

    const db = await getSqliteDb();
    const before = await db.get(`SELECT * FROM claims WHERE id = ?`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'claim not found' });

    for (const f of allowed) {
      if (!(f in fields)) continue;
      const newVal = fields[f] === '' ? null : fields[f];
      if (before[f] === newVal) continue; // no-op
      updates.push(`${f} = ?`);
      params.push(newVal);
      auditRows.push({ field: f, original: before[f], corrected: newVal });
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no fields actually changed' });

    updates.push(`review_status = 'edited'`, `reviewer_id = ?`, `reviewed_at = datetime('now')`);
    params.push(reviewer);
    params.push(req.params.id);

    await db.exec('BEGIN');
    try {
      await db.run(`UPDATE claims SET ${updates.join(', ')} WHERE id = ?`, params);
      for (const a of auditRows) {
        await db.run(
          `INSERT INTO extractor_corrections (claim_id, field, original, corrected, reviewer_id, reasoning) VALUES (?, ?, ?, ?, ?, ?)`,
          [req.params.id, a.field, a.original == null ? null : String(a.original), a.corrected == null ? null : String(a.corrected), reviewer, reasoning]
        );
      }
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    const after = await db.get(`SELECT * FROM claims WHERE id = ?`, [req.params.id]);
    res.json({ id: parseInt(req.params.id, 10), updated: after, corrections: auditRows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/review/sources
 * Body: { title (required), authors, year, publication, source_type,
 *         license, url, doi, file_path, access_level }
 *
 * Create a new source row. Slug is auto-generated from title (with
 * naive slugify) — partner can edit it later via PATCH if needed.
 * Returns the created row with its assigned id.
 */
app.post('/api/admin/review/sources', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title is required' });
    const allowed = ['title', 'authors', 'year', 'publication', 'source_type', 'license', 'url', 'doi', 'file_path', 'access_level'];
    const cols = ['title'];
    const vals = [b.title.trim()];
    for (const f of allowed.slice(1)) {
      if (f in b && b[f] !== '') {
        cols.push(f);
        vals.push(b[f]);
      }
    }
    cols.push('ingested_at');
    vals.push(new Date().toISOString());
    // Generate slug from title (minimal slugify; collisions get -2, -3, etc.).
    const baseSlug = String(b.title)
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || `source-${Date.now()}`;
    let slug = baseSlug;
    let suffix = 2;
    const db = await getSqliteDb();
    while (await db.get(`SELECT id FROM sources WHERE slug = ?`, [slug])) {
      slug = `${baseSlug}-${suffix}`; suffix++;
    }
    cols.push('slug'); vals.push(slug);
    const placeholders = cols.map(() => '?').join(',');
    const result = await db.run(
      `INSERT INTO sources (${cols.join(',')}) VALUES (${placeholders})`,
      vals
    );
    const created = await db.get(`SELECT * FROM sources WHERE id = ?`, [result.lastID]);
    res.json({ id: result.lastID, created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/admin/review/sources/:id
 * Body: any subset of { title, authors, year, publication, source_type, license, url, doi }
 *
 * Inline-edit support for the Sources tab. Only allowlisted columns can
 * be updated. Returns the updated row.
 */
app.patch('/api/admin/review/sources/:id', async (req, res) => {
  try {
    const allowed = ['title', 'authors', 'year', 'publication', 'source_type', 'license', 'url', 'doi'];
    const updates = [];
    const params = [];
    for (const f of allowed) {
      if (f in (req.body || {})) {
        updates.push(`${f} = ?`);
        const v = req.body[f];
        params.push(v === '' ? null : v);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no allowlisted fields in body' });
    params.push(req.params.id);
    const db = await getSqliteDb();
    const result = await db.run(`UPDATE sources SET ${updates.join(', ')} WHERE id = ?`, params);
    if (result.changes === 0) return res.status(404).json({ error: 'source not found' });
    const updated = await db.get(`SELECT * FROM sources WHERE id = ?`, [req.params.id]);
    res.json({ id: parseInt(req.params.id, 10), updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/admin/review/entities/:id
 * Body: any subset of { common_name, family, genus, primary_role, crop_type, edible, needs_dedup, taxonomy_path, bio_category }
 *
 * Inline-edit support for the Entities tab. scientific_name and slug are
 * intentionally NOT editable here (they're identity fields — changing
 * scientific_name should go through a deliberate rename + slug-update
 * workflow that doesn't yet exist).
 */
app.patch('/api/admin/review/entities/:id', async (req, res) => {
  try {
    // Expanded allowlist covers identity + taxonomy + environmental (Trefle-
    // style for plants, plus equivalents for animals/microbes/fungi).
    // scientific_name and slug remain off-limits — they're identity fields.
    const allowed = [
      // identity / taxonomy
      'common_name', 'family', 'family_common_name', 'genus', 'taxonomy_path',
      'bio_category', 'primary_role', 'crop_type', 'crop_subtype',
      'organism_type', 'kingdom', 'phylum', 'taxon_class', 'taxon_order',
      'edible', 'vegetable', 'edible_part', 'toxicity', 'duration',
      'needs_dedup', 'agroeco_functions', 'image_url',
      // environmental — temperature
      'min_temp_c', 'max_temp_c',
      'thermal_min', 'thermal_max',
      'optimal_temp_min', 'optimal_temp_max',
      'tolerance_temp_min', 'tolerance_temp_max',
      'favorable_temp_min', 'favorable_temp_max',
      'thermal_kill_point', 'degree_days', 'degree_days_base10',
      // humidity / precipitation
      'atmospheric_humidity', 'optimal_humidity_min', 'optimal_humidity_max',
      'favorable_humidity',
      'min_precipitation_mm', 'max_precipitation_mm',
      'optimal_precip_min', 'optimal_precip_max',
      'leaf_wetness_hours',
      // soil / pH
      'soil_texture', 'soil_humidity', 'soil_nutriments', 'soil_salinity',
      'optimal_soil_moisture', 'optimal_soil_texture',
      'ph_min', 'ph_max', 'optimal_ph_min', 'optimal_ph_max',
      'favorable_soil_organic_matter', 'soil_persistence_years',
      'soil_health_function',
      // light
      'light_requirement', 'optimal_light',
      // morphology (plants)
      'average_height_cm', 'maximum_height_cm', 'spread_cm',
      'row_spacing_cm', 'min_root_depth_cm',
      'growth_rate', 'growth_habit', 'growth_form', 'ligneous_type',
      'shape_and_orientation', 'wind_sensitivity',
      // crop-trait
      'days_to_harvest', 'nitrogen_fixation',
      // phenology / activity
      'growth_months', 'bloom_months', 'fruit_months', 'activity_months',
      'favorable_season',
      // ranges / regions
      'native_zones', 'introduced_zones', 'native_regions', 'invasive_regions',
      'climate_zone',
      // animal / insect biology
      'pest_mobility', 'host_range', 'life_cycle_type', 'voltinism',
      'diet_breadth', 'diet_type', 'crop_damage_type', 'dispersal_range',
      'larval_role', 'adult_role', 'commercial_biocontrol', 'migration_pattern',
      'activity_pattern', 'vulnerable_host_stage', 'known_natural_enemies',
      // pathogen biology
      'disease_name', 'transmission_mode', 'transmission_vector',
      'pathogen_subtype', 'frac_group', 'seed_borne', 'survival_structure',
      'favorable_soil_organic_matter',
      // habitat (animals)
      'habitat_type', 'conservation_status'
    ];
    const updates = [];
    const params = [];
    for (const f of allowed) {
      if (f in (req.body || {})) {
        updates.push(`${f} = ?`);
        const v = req.body[f];
        params.push(v === '' ? null : v);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no allowlisted fields in body' });
    params.push(req.params.id);
    const db = await getSqliteDb();
    const result = await db.run(`UPDATE entities SET ${updates.join(', ')} WHERE id = ?`, params);
    if (result.changes === 0) return res.status(404).json({ error: 'entity not found' });
    const updated = await db.get(`SELECT * FROM entities WHERE id = ?`, [req.params.id]);
    res.json({ id: parseInt(req.params.id, 10), updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/review/:id/accept   Body: { reviewer? }
 */
app.post('/api/admin/review/:id/accept', (req, res) => applyReviewAction(req, res, 'human_verified'));

/**
 * POST /api/admin/review/:id/reject   Body: { reviewer? }
 */
app.post('/api/admin/review/:id/reject', (req, res) => applyReviewAction(req, res, 'human_rejected'));

/**
 * POST /api/admin/review/:id/flag     Body: { reviewer? }
 */
app.post('/api/admin/review/:id/flag', (req, res) => applyReviewAction(req, res, 'disputed'));

/**
 * GET /api/admin/pending-crops
 * List crop stubs awaiting Trefle contribution.
 */
app.get('/api/admin/pending-crops', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const items = await db.all(
      `SELECT pc.*, s.title as source_title
       FROM pending_crops pc
       LEFT JOIN sources s ON s.id = pc.source_id
       ORDER BY pc.created_at DESC`
    );
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/pending-crops/:id/submitted
 * Mark a crop stub as submitted to Trefle.
 */
app.post('/api/admin/pending-crops/:id/submitted', async (req, res) => {
  try {
    const db = await getSqliteDb();
    await db.run('UPDATE pending_crops SET trefle_submitted = 1 WHERE id = ?', req.params.id);
    res.json({ id: parseInt(req.params.id), trefle_submitted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/data/claims
 * Query the unified claims table.
 * ?region=&search=&category=&page=1&limit=50
 */
app.get('/api/admin/data/claims', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const country = req.query.country || '';
    const subdivision = req.query.subdivision || '';
    const search = req.query.search || '';
    const category = req.query.category || '';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    let where = '1=1';
    const params = [];

    if (country) {
      where += ' AND c.country = ?';
      params.push(country);
      if (subdivision) {
        where += ' AND c.subdivision = ?';
        params.push(subdivision);
      }
    }
    if (search) {
      where += ' AND (e_sub.scientific_name LIKE ? COLLATE NOCASE OR e_obj.scientific_name LIKE ? COLLATE NOCASE OR e_sub.common_name LIKE ? COLLATE NOCASE OR e_obj.common_name LIKE ? COLLATE NOCASE)';
      const p = `%${search}%`;
      params.push(p, p, p, p);
    }
    if (category) {
      where += ' AND c.interaction_category = ?';
      params.push(category);
    }

    const countResult = await db.get(
      `SELECT COUNT(*) AS total FROM claims c
       JOIN entities e_sub ON e_sub.id = c.subject_entity_id
       JOIN entities e_obj ON e_obj.id = c.object_entity_id
       WHERE ${where}`,
      params
    );

    const items = await db.all(
      `SELECT c.id, c.data_tier AS claim_type,
              e_sub.scientific_name AS subject_biota, e_sub.common_name AS subject_common,
              e_sub.bio_category AS subject_bio_cat,
              e_obj.scientific_name AS object_biota, e_obj.common_name AS object_common,
              e_obj.bio_category AS object_bio_cat,
              c.interaction_category AS relationship, c.interaction_type_raw,
              c.effect_direction AS direction_severity,
              c.confidence_score, c.evidence_tier,
              c.country, c.subdivision,
              c.extracted_claim, c.source_quote, c.mechanism,
              c.effect_magnitude, c.study_scale, c.source_page,
              s.title AS source_title, s.url AS source_url,
              c.source_id, c.created_at,
              c.interaction_count, c.locality_count
       FROM claims c
       JOIN entities e_sub ON e_sub.id = c.subject_entity_id
       JOIN entities e_obj ON e_obj.id = c.object_entity_id
       LEFT JOIN sources s ON s.id = c.source_id
       WHERE ${where}
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ items, total: countResult.total, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/data/entities
 * Query the unified entities table.
 * ?search=&type=crop|pest|pathogen|beneficial|pollinator&bio_category=&page=1&limit=50&sort=scientific_name&sort_dir=asc
 */
app.get('/api/admin/data/entities', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const search = req.query.search || '';
    const type = req.query.type || '';
    const bioCategory = req.query.bio_category || '';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    // Sortable columns whitelist
    const sortableColumns = new Set([
      'scientific_name', 'common_name', 'variety_name', 'bio_category', 'primary_role',
      'kingdom', 'phylum', 'taxon_class', 'taxon_order', 'family', 'genus',
      'crop_type', 'source_table', 'data_completeness',
      'average_height_cm', 'growth_habit', 'growth_rate', 'duration', 'edible',
      'optimal_light', 'optimal_humidity_min', 'optimal_ph_min', 'optimal_ph_max',
      'optimal_precip_min', 'optimal_precip_max', 'optimal_temp_min', 'optimal_temp_max',
      'optimal_soil_texture', 'optimal_soil_moisture', 'soil_nutriments', 'soil_salinity',
      'nitrogen_fixation', 'created_at', 'updated_at',
    ]);
    const sortCol = sortableColumns.has(req.query.sort) ? req.query.sort : null;
    const sortDir = req.query.sort_dir === 'desc' ? 'DESC' : 'ASC';

    const roleMap = {
      crop: ['crop'],
      pest: ['pest_insect', 'pest_vertebrate', 'pest_mite'],
      pathogen: ['pathogen_fungal', 'pathogen_bacterial', 'pathogen_viral', 'pathogen_nematode'],
      beneficial: ['beneficial_predator', 'beneficial_parasitoid', 'biocontrol', 'soil_microbe'],
      pollinator: ['pollinator'],
      weed: ['weed'],
      wild_plant: ['wild_plant'],
    };

    let where = 'parent_entity_id IS NULL';
    const params = [];

    if (type && roleMap[type]) {
      const roles = roleMap[type];
      where += ` AND primary_role IN (${roles.map(() => '?').join(',')})`;
      params.push(...roles);
    }
    if (bioCategory) {
      where += ' AND bio_category = ?';
      params.push(bioCategory);
    }
    if (search) {
      where += ' AND (scientific_name LIKE ? COLLATE NOCASE OR common_name LIKE ? COLLATE NOCASE)';
      const p = `%${search}%`;
      params.push(p, p);
    }
    if (req.query.has_varieties === '1') {
      where += ' AND id IN (SELECT DISTINCT parent_entity_id FROM entities WHERE parent_entity_id IS NOT NULL)';
    }

    const countResult = await db.get(
      `SELECT COUNT(*) AS total FROM entities WHERE ${where}`, params
    );

    const items = await db.all(
      `SELECT ${ENTITY_SELECT_COLS}
       FROM entities WHERE ${where}
       ORDER BY ${sortCol ? `${sortCol} ${sortDir},` : ''} scientific_name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Get variety counts for returned parents
    const ids = items.map(e => e.id);
    let varietyCounts = {};
    if (ids.length) {
      const vcRows = await db.all(
        `SELECT parent_entity_id, COUNT(*) as cnt FROM entities WHERE parent_entity_id IN (${ids.map(() => '?').join(',')}) GROUP BY parent_entity_id`,
        ids
      );
      for (const r of vcRows) varietyCounts[r.parent_entity_id] = r.cnt;
    }

    res.json({
      items: items.map(e => ({
        ...e,
        entity_type: e.primary_role,
        agroeco_functions: e.agroeco_functions ? JSON.parse(e.agroeco_functions) : [],
        variety_count: varietyCounts[e.id] || 0,
      })),
      total: countResult.total,
      page,
      limit
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/data/entities/:id/varieties
 * Fetch varieties for a parent entity.
 */
app.get('/api/admin/data/entities/:id/varieties', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const parentId = parseInt(req.params.id, 10);
    const items = await db.all(
      `SELECT ${ENTITY_SELECT_COLS}
       FROM entities WHERE parent_entity_id = ?
       ORDER BY variety_name ASC`,
      [parentId]
    );
    res.json(items.map(e => ({
      ...e,
      entity_type: e.primary_role,
      agroeco_functions: e.agroeco_functions ? JSON.parse(e.agroeco_functions) : [],
      variety_count: 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/data/entities/:id
 * Update an entity directly. Logs role/bio_category corrections automatically.
 */
app.put('/api/admin/data/entities/:id', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const allowed = [
      'scientific_name', 'common_name', 'family', 'family_common_name', 'genus',
      'bio_category', 'primary_role', 'crop_type', 'climate_zone',
      'growth_habit', 'growth_rate', 'growth_form', 'days_to_harvest',
      'optimal_ph_min', 'optimal_ph_max', 'min_root_depth_cm', 'nitrogen_fixation',
      'optimal_soil_texture', 'optimal_soil_moisture', 'soil_nutriments',
      'optimal_temp_min', 'optimal_temp_max', 'tolerance_temp_min', 'tolerance_temp_max',
      'optimal_humidity_min', 'optimal_humidity_max',
      'optimal_precip_min', 'optimal_precip_max',
      'optimal_light', 'degree_days_base10',
      'vulnerable_host_stage', 'favorable_season', 'known_natural_enemies',
      'favorable_soil_organic_matter', 'wind_sensitivity', 'leaf_wetness_hours', 'thermal_kill_point',
      'average_height_cm', 'maximum_height_cm',
      'spread_cm', 'duration', 'edible', 'vegetable',
      'organism_type', 'pest_mobility', 'data_completeness',
      'variety_name', 'grin_accession'
    ];
    const sets = [];
    const vals = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = ?`);
        vals.push(req.body[field]);
      }
    }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });

    // Fetch old values before update for correction logging
    const old = await db.get(
      'SELECT primary_role, bio_category, scientific_name FROM entities WHERE id = ?',
      [req.params.id]
    );

    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    await db.run(`UPDATE entities SET ${sets.join(', ')} WHERE id = ?`, vals);

    // Log correction if primary_role or bio_category changed
    if (old) {
      const newRole = req.body.primary_role;
      const newBio = req.body.bio_category;
      if ((newRole && newRole !== old.primary_role) || (newBio && newBio !== old.bio_category)) {
        try {
          await db.run(`INSERT INTO role_corrections
            (entity_id, scientific_name, old_role, new_role, old_bio_category, new_bio_category, source, reason)
            VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`,
            [req.params.id, old.scientific_name,
             old.primary_role, newRole || old.primary_role,
             old.bio_category, newBio || old.bio_category,
             req.body.correction_reason || null]);
        } catch (_) { /* correction logging is best-effort */ }
      }
    }

    res.json({ id: req.params.id, updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/data/claims/:id
 * Update a claim directly.
 */
app.put('/api/admin/data/claims/:id', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const allowed = [
      'interaction_type_raw', 'interaction_category', 'effect_direction',
      'confidence_score', 'applied_weight', 'evidence_tier', 'mechanism',
      'impact_class', 'extracted_claim', 'source_quote', 'source_page',
      'effect_magnitude', 'study_scale', 'study_duration',
      'regional_context', 'season_context', 'soil_context'
    ];
    const sets = [];
    const vals = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = ?`);
        vals.push(req.body[field]);
      }
    }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });

    vals.push(req.params.id);
    await db.run(`UPDATE claims SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ id: req.params.id, updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Role Agent Endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/admin/corrections
 * Paginated correction history.
 */
app.get('/api/admin/corrections', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const unreviewed = req.query.unreviewed === '1';

    let where = '1=1';
    if (unreviewed) where = 'rc.reviewed = 0';

    const total = await db.get(`SELECT COUNT(*) as n FROM role_corrections rc WHERE ${where}`);
    const items = await db.all(`
      SELECT rc.*, e.family, e.genus, e.bio_category as current_bio
      FROM role_corrections rc
      JOIN entities e ON rc.entity_id = e.id
      WHERE ${where}
      ORDER BY rc.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    res.json({ items, total: total.n, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/entities/:id/role-history
 * Correction history for a single entity.
 */
app.get('/api/admin/entities/:id/role-history', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const items = await db.all(`
      SELECT * FROM role_corrections
      WHERE entity_id = ?
      ORDER BY created_at DESC
    `, [req.params.id]);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/role-rules
 * List all rules, filterable.
 */
app.get('/api/admin/role-rules', async (req, res) => {
  try {
    const db = await getSqliteDb();
    let where = '1=1';
    const params = [];
    if (req.query.type) { where += ' AND rule_type = ?'; params.push(req.query.type); }
    if (req.query.enabled !== undefined) { where += ' AND enabled = ?'; params.push(req.query.enabled === '1' ? 1 : 0); }
    if (req.query.role) { where += ' AND assigned_role = ?'; params.push(req.query.role); }

    const items = await db.all(
      `SELECT * FROM role_rules WHERE ${where} ORDER BY priority DESC, id ASC`,
      params
    );
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/role-rules/:id
 * Update a rule (enable/disable, change role, etc.).
 */
app.put('/api/admin/role-rules/:id', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const allowed = [
      'assigned_role', 'secondary_role', 'confidence', 'priority',
      'reason', 'enabled', 'match_bio_category'
    ];
    const sets = [];
    const vals = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = ?`);
        vals.push(req.body[field]);
      }
    }
    if (sets.length === 0) return res.json({ id: req.params.id, updated: false });
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    await db.run(`UPDATE role_rules SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ id: req.params.id, updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/role-rules
 * Create a new rule.
 */
app.post('/api/admin/role-rules', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const { rule_type, match_field, match_value, match_bio_category,
            assigned_role, secondary_role, confidence, priority, reason, source } = req.body;
    if (!rule_type || !match_field || !match_value || !assigned_role) {
      return res.status(400).json({ error: 'rule_type, match_field, match_value, assigned_role are required' });
    }
    const result = await db.run(`
      INSERT INTO role_rules (rule_type, match_field, match_value, match_bio_category,
        assigned_role, secondary_role, confidence, priority, reason, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [rule_type, match_field, match_value, match_bio_category || null,
        assigned_role, secondary_role || null, confidence || 1.0,
        priority || 50, reason || null, source || 'manual']);
    res.json({ id: result.lastID, created: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Climate Grid API ─────────────────────────────────────────────────────────

/**
 * GET /api/site/profile?lat=36.65&lon=-121.80
 * Returns a themed environmental profile (climate / bioclim / phenology /
 * soil / zones) for the nearest climate_grid cell, plus distance-tiered
 * coverage_confidence and per-section coverage flags.
 * See docs/superpowers/specs/2026-04-17-site-profile-endpoint-design.md.
 */
app.get('/api/site/profile', async (req, res) => {
  try {
    const parsed = parseLatLon(req.query.lat, req.query.lon);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const db = await getSqliteDb();
    const cell = await db.get(
      `SELECT * FROM climate_grid
       ORDER BY ABS(lat - ?) + ABS(lon - ?)
       LIMIT 1`,
      [parsed.lat, parsed.lon]
    );
    if (!cell) {
      return res.status(503).json({ error: 'climate_grid is empty' });
    }
    res.json(buildSiteProfile(cell, parsed.lat, parsed.lon));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/climate/match?lat=36.65&lon=-121.80&role=pathogen&crop_id=123
 * Returns organisms whose optimal conditions overlap the location's climate.
 */
app.get('/api/climate/match', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'lat and lon query parameters required' });
    }
    const db = await getSqliteDb();

    const cell = await db.get(
      `SELECT * FROM climate_grid ORDER BY ABS(lat - ?) + ABS(lon - ?) LIMIT 1`,
      [lat, lon]
    );
    if (!cell) {
      return res.status(404).json({ error: 'No climate data available for this location' });
    }

    const roleMap = {
      crop: ['crop'],
      pest: ['pest_insect', 'pest_vertebrate', 'pest_mite'],
      pathogen: ['pathogen_fungal', 'pathogen_bacterial', 'pathogen_viral', 'pathogen_nematode'],
      beneficial: ['beneficial_predator', 'beneficial_parasitoid', 'biocontrol', 'soil_microbe'],
      pollinator: ['pollinator'],
      weed: ['weed'],
    };

    let where = 'e.parent_entity_id IS NULL';
    const params = [];

    const role = req.query.role;
    if (role && roleMap[role]) {
      const roles = roleMap[role];
      where += ` AND e.primary_role IN (${roles.map(() => '?').join(',')})`;
      params.push(...roles);
    }

    where += ` AND (e.optimal_temp_min IS NULL OR e.optimal_temp_min <= ?)`;
    params.push(cell.bio10_mean_temp_warmest_q ?? 50);
    where += ` AND (e.optimal_temp_max IS NULL OR e.optimal_temp_max >= ?)`;
    params.push(cell.bio11_mean_temp_coldest_q ?? -50);

    where += ` AND (e.optimal_precip_min IS NULL OR e.optimal_precip_min <= ?)`;
    params.push(cell.bio12_annual_precip ?? 99999);
    where += ` AND (e.optimal_precip_max IS NULL OR e.optimal_precip_max >= ?)`;
    params.push(cell.bio12_annual_precip ?? 0);

    const cropId = parseInt(req.query.crop_id, 10);
    if (!isNaN(cropId)) {
      const climateMatchGateClause = shouldApplyReviewGate(req) ? `AND ${REVIEW_GATE_SQL}` : '';
      where += ` AND e.id IN (
        SELECT CASE WHEN c.subject_entity_id = ? THEN c.object_entity_id
                    ELSE c.subject_entity_id END
        FROM claims c
        WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
          ${climateMatchGateClause}
      )`;
      params.push(cropId, cropId, cropId);
    }

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    params.push(limit);

    // Bridge climate_grid soil fields to the INT 1-10 scale that entities use.
    // Texture: USDA class -> {3,6,9} buckets matching ECOCROP L/M/H mapping.
    // Moisture: de Martonne index / 5, clamped to [0,10] (humid ~30 -> 6/10).
    const TEXTURE_BUCKET = {
      'sand': 3, 'loamy sand': 3, 'sandy loam': 3,
      'loam': 6, 'silt loam': 6, 'silt': 6, 'sandy clay loam': 6,
      'clay loam': 9, 'silty clay loam': 9, 'clay': 9, 'silty clay': 9, 'sandy clay': 9,
    };
    const cellTextureBucket = TEXTURE_BUCKET[cell.soil_texture_class] ?? null;
    const cellMoistureBucket = cell.soil_moisture_index != null
      ? Math.max(0, Math.min(10, cell.soil_moisture_index / 5))
      : null;
    const cellNutriments = cell.soil_nutriments_0_10 ?? null;

    const items = await db.all(`
      SELECT e.id, e.scientific_name, e.common_name, e.primary_role, e.bio_category,
             e.organism_type, e.optimal_temp_min, e.optimal_temp_max,
             e.optimal_precip_min, e.optimal_precip_max,
             e.optimal_humidity_min, e.optimal_ph_min, e.optimal_ph_max,
             e.optimal_soil_texture, e.optimal_soil_moisture, e.soil_nutriments,
             e.min_root_depth_cm,
             e.favorable_season, e.vulnerable_host_stage,
             (CASE WHEN e.optimal_temp_min IS NOT NULL AND e.optimal_temp_max IS NOT NULL
                   AND ? BETWEEN e.optimal_temp_min AND e.optimal_temp_max
              THEN 1 ELSE 0 END) +
             (CASE WHEN e.optimal_precip_min IS NOT NULL AND e.optimal_precip_max IS NOT NULL
                   AND ? BETWEEN e.optimal_precip_min AND e.optimal_precip_max
              THEN 1 ELSE 0 END) +
             (CASE WHEN e.optimal_ph_min IS NOT NULL AND e.optimal_ph_max IS NOT NULL
                   AND ? BETWEEN e.optimal_ph_min AND e.optimal_ph_max
              THEN 1 ELSE 0 END) +
             (CASE WHEN e.soil_nutriments IS NOT NULL AND ? IS NOT NULL
                   AND ABS(? - e.soil_nutriments) <= 3
              THEN 1 ELSE 0 END) +
             (CASE WHEN e.optimal_soil_texture IS NOT NULL AND ? IS NOT NULL
                   AND ABS(? - e.optimal_soil_texture) <= 3
              THEN 1 ELSE 0 END) +
             (CASE WHEN e.optimal_soil_moisture IS NOT NULL AND ? IS NOT NULL
                   AND ABS(? - e.optimal_soil_moisture) <= 3
              THEN 1 ELSE 0 END)
             AS match_score,
             (CASE WHEN e.optimal_temp_min IS NOT NULL THEN 1 ELSE 0 END) +
             (CASE WHEN e.optimal_precip_min IS NOT NULL THEN 1 ELSE 0 END) +
             (CASE WHEN e.optimal_ph_min IS NOT NULL THEN 1 ELSE 0 END) +
             (CASE WHEN e.soil_nutriments IS NOT NULL THEN 1 ELSE 0 END) +
             (CASE WHEN e.optimal_soil_texture IS NOT NULL THEN 1 ELSE 0 END) +
             (CASE WHEN e.optimal_soil_moisture IS NOT NULL THEN 1 ELSE 0 END)
             AS data_completeness_score
      FROM entities e
      WHERE ${where}
      ORDER BY match_score DESC, data_completeness_score DESC, e.scientific_name
      LIMIT ?
    `, [
      cell.bio1_annual_mean_temp ?? 15,
      cell.bio12_annual_precip ?? 1000,
      cell.soil_ph_surface ?? 6.5,
      cellNutriments, cellNutriments,
      cellTextureBucket, cellTextureBucket,
      cellMoistureBucket, cellMoistureBucket,
      ...params,
    ]);

    res.json({
      location: {
        lat: cell.lat, lon: cell.lon, elevation_m: cell.elevation_m,
        koppen_zone: cell.koppen_zone, hardiness_zone: cell.hardiness_zone,
        annual_mean_temp_c: cell.bio1_annual_mean_temp,
        annual_precip_mm: cell.bio12_annual_precip,
        soil_ph_surface: cell.soil_ph_surface,
        soil_texture_class: cell.soil_texture_class,
        soil_nutriments_0_10: cell.soil_nutriments_0_10,
        soil_moisture_index: cell.soil_moisture_index,
        soil_texture_bucket: cellTextureBucket,
        soil_moisture_bucket: cellMoistureBucket != null ? Math.round(cellMoistureBucket * 10) / 10 : null,
      },
      matches: items.map(e => ({
        ...e,
        favorable_season: e.favorable_season ? JSON.parse(e.favorable_season) : [],
        vulnerable_host_stage: e.vulnerable_host_stage ? JSON.parse(e.vulnerable_host_stage) : [],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/climate/grid
 * Paginated listing of climate grid cells with filtering.
 */
app.get('/api/climate/grid', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    let where = '1=1';
    const params = [];

    // Text search: koppen or hardiness zone
    const q = (req.query.q || '').trim();
    if (q) {
      where += ` AND (koppen_zone LIKE ? OR hardiness_zone LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }

    // Exact filters
    if (req.query.koppen) {
      where += ` AND koppen_zone = ?`;
      params.push(req.query.koppen);
    }
    if (req.query.hardiness) {
      where += ` AND hardiness_zone = ?`;
      params.push(req.query.hardiness);
    }

    // Range filters
    const tempMin = parseFloat(req.query.temp_min);
    if (!isNaN(tempMin)) {
      where += ` AND bio1_annual_mean_temp >= ?`;
      params.push(tempMin);
    }
    const tempMax = parseFloat(req.query.temp_max);
    if (!isNaN(tempMax)) {
      where += ` AND bio1_annual_mean_temp <= ?`;
      params.push(tempMax);
    }
    const precipMin = parseFloat(req.query.precip_min);
    if (!isNaN(precipMin)) {
      where += ` AND bio12_annual_precip >= ?`;
      params.push(precipMin);
    }
    const precipMax = parseFloat(req.query.precip_max);
    if (!isNaN(precipMax)) {
      where += ` AND bio12_annual_precip <= ?`;
      params.push(precipMax);
    }

    // Sorting
    const allowedSorts = ['lat', 'lon',
      'bio1_annual_mean_temp', 'bio5_max_temp_warmest', 'bio6_min_temp_coldest',
      'bio12_annual_precip', 'bio13_precip_wettest_month', 'bio14_precip_driest_month',
      'koppen_zone', 'hardiness_zone',
      'frost_free_days', 'growing_degree_days', 'first_frost_doy', 'last_frost_doy',
      'soil_ph_surface', 'soil_clay_pct', 'soil_sand_pct', 'soil_silt_pct',
      'soil_organic_carbon', 'soil_cec', 'soil_nitrogen',
      'elevation_m'];
    const sort = allowedSorts.includes(req.query.sort) ? req.query.sort : 'lat';
    const order = req.query.order === 'desc' ? 'DESC' : 'ASC';

    // Get total count
    const countRow = await db.get(`SELECT COUNT(*) as total FROM climate_grid WHERE ${where}`, params);

    // Get page of rows
    const rows = await db.all(
      `SELECT * FROM climate_grid WHERE ${where} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Parse monthly JSON arrays
    for (const row of rows) {
      row.monthly_temp_high = row.monthly_temp_high ? JSON.parse(row.monthly_temp_high) : null;
      row.monthly_temp_low  = row.monthly_temp_low  ? JSON.parse(row.monthly_temp_low)  : null;
      row.monthly_precip_mm = row.monthly_precip_mm ? JSON.parse(row.monthly_precip_mm) : null;
      row.monthly_humidity  = row.monthly_humidity  ? JSON.parse(row.monthly_humidity)  : null;
    }

    // Get distinct filter values for dropdowns
    const koppenZones = await db.all('SELECT DISTINCT koppen_zone FROM climate_grid WHERE koppen_zone IS NOT NULL ORDER BY koppen_zone');
    const hardinessZones = await db.all('SELECT DISTINCT hardiness_zone FROM climate_grid WHERE hardiness_zone IS NOT NULL ORDER BY hardiness_zone');

    res.json({
      total: countRow.total,
      page,
      limit,
      filters: {
        koppen_zones: koppenZones.map(r => r.koppen_zone),
        hardiness_zones: hardinessZones.map(r => r.hardiness_zone),
      },
      rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/entity-traits
 * Paginated list of entity_trait_claims with status_counts. Drives the
 * Database > Entity Traits sub-tab.
 * Query params: page, pageSize, review_status, trait_name, entity_id,
 *               source_id, search, show_misaligned (1=disable bio_category filter)
 */
app.get('/api/admin/review/entity-traits', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset   = (page - 1) * pageSize;

    const where = [];
    const params = [];
    const countsWhere = [];
    const countsParams = [];

    if (req.query.trait_name) {
      where.push('etc.trait_name = ?');
      params.push(req.query.trait_name);
      countsWhere.push('etc.trait_name = ?');
      countsParams.push(req.query.trait_name);
    }
    if (req.query.entity_id) {
      where.push('etc.entity_id = ?');
      params.push(parseInt(req.query.entity_id, 10));
      countsWhere.push('etc.entity_id = ?');
      countsParams.push(parseInt(req.query.entity_id, 10));
    }
    if (req.query.source_id) {
      where.push('etc.source_id = ?');
      params.push(parseInt(req.query.source_id, 10));
      countsWhere.push('etc.source_id = ?');
      countsParams.push(parseInt(req.query.source_id, 10));
    }
    if (req.query.staging_id) {
      const clause = 'etc.staging_id = ?';
      where.push(clause); params.push(parseInt(req.query.staging_id, 10));
      countsWhere.push(clause); countsParams.push(parseInt(req.query.staging_id, 10));
    }
    if (req.query.id) {
      const clause = 'etc.id = ?';
      where.push(clause); params.push(parseInt(req.query.id, 10));
      countsWhere.push(clause); countsParams.push(parseInt(req.query.id, 10));
    }
    if (req.query.search) {
      const like = `%${req.query.search}%`;
      where.push('(e.scientific_name LIKE ? OR etc.trait_name LIKE ? OR etc.value_text LIKE ?)');
      params.push(like, like, like);
      countsWhere.push('(e.scientific_name LIKE ? OR etc.trait_name LIKE ? OR etc.value_text LIKE ?)');
      countsParams.push(like, like, like);
    }
    // review_status filter applies to items but NOT to status_counts (so chips are stable)
    if (req.query.review_status) {
      where.push('etc.review_status = ?');
      params.push(req.query.review_status);
    }

    // bio_category alignment filter: only show rows where the trait's applicable_bio_categories
    // includes the entity's bio_category. show_misaligned=1 disables this for cleanup workflows.
    const showMisaligned = req.query.show_misaligned === '1';
    if (!showMisaligned) {
      const alignClause = `EXISTS (
        SELECT 1 FROM traits_vocabulary tv
         CROSS JOIN json_each(tv.applicable_bio_categories) je
        WHERE tv.trait_name = etc.trait_name AND je.value = e.bio_category
      )`;
      where.push(alignClause);
      countsWhere.push(alignClause);
    }

    const whereSql       = where.length       ? `WHERE ${where.join(' AND ')}`       : '';
    const countsWhereSql = countsWhere.length  ? `WHERE ${countsWhere.join(' AND ')}` : '';

    const baseJoin = `
      FROM entity_trait_claims etc
      LEFT JOIN entities e ON e.id = etc.entity_id
      LEFT JOIN sources  s ON s.id = etc.source_id`;

    const items = await db.all(
      `SELECT
         etc.id, etc.entity_id,
         e.scientific_name AS entity_scientific_name,
         e.common_name     AS entity_common_name,
         etc.trait_name, etc.value_numeric, etc.value_text, etc.value_json, etc.unit,
         etc.source_id, s.title AS source_title,
         etc.source_quote, etc.source_page, etc.regional_context,
         etc.staging_id,
         etc.review_status, etc.ai_vouch_status, etc.ai_vouch_note,
         etc.created_at,
         CASE WHEN s.file_path IS NOT NULL AND s.file_path != '' THEN 1 ELSE 0 END AS source_has_pdf,
         (SELECT GROUP_CONCAT(cv.critic_name || '|' || cv.verdict || '|' || COALESCE(REPLACE(REPLACE(cv.reasoning, '|', '/'), CHAR(10), ' '), '') || '|' || COALESCE(cv.critic_confidence, '') || '|' || COALESCE(cv.evidence_strength, ''), CHAR(10))
            FROM claim_critic_verdicts cv
            WHERE cv.staging_id = etc.staging_id
         ) AS critic_verdicts
       ${baseJoin}
       ${whereSql}
       ORDER BY etc.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const totalRow = await db.get(
      `SELECT COUNT(*) AS n ${baseJoin} ${whereSql}`,
      params
    );

    const statusRows = await db.all(
      `SELECT etc.review_status, COUNT(*) AS n ${baseJoin} ${countsWhereSql} GROUP BY etc.review_status`,
      countsParams
    );
    const status_counts = {
      unreviewed: 0, ai_vouched: 0, ai_reviewed: 0,
      human_verified: 0, edited: 0, disputed: 0, superseded: 0
    };
    for (const r of statusRows) {
      if (r.review_status in status_counts) status_counts[r.review_status] = r.n;
    }

    res.json({ items, total: totalRow ? totalRow.n : 0, status_counts, page, pageSize });
  } catch (err) {
    console.error('entity-traits endpoint error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/admin/review/entity-traits/:id
 * Update review_status on a single entity_trait_claims row.
 * Body: { review_status: 'human_verified' | 'human_rejected' | 'disputed' | 'ai_reviewed' }
 */
app.patch('/api/admin/review/entity-traits/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const { review_status } = req.body || {};
  if (!['human_verified', 'human_rejected', 'disputed', 'ai_reviewed'].includes(review_status)) {
    return res.status(400).json({ error: 'invalid review_status' });
  }
  try {
    const db = await getSqliteDb();
    await db.run(
      "UPDATE entity_trait_claims SET review_status = ?, reviewed_at = datetime('now') WHERE id = ?",
      [review_status, id]
    );
    res.json({ ok: true, id, review_status });
  } catch (err) {
    console.error('entity-traits PATCH error', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/admin/review/priority
 * Paginated list from the v_review_priority view (migration 036).
 * Drives the Priority queue sub-tab.
 */
app.get('/api/admin/review/priority', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset   = (page - 1) * pageSize;

    const totalRow = await db.get('SELECT COUNT(*) AS n FROM v_review_priority');
    const items    = await db.all(
      'SELECT * FROM v_review_priority ORDER BY priority_score DESC LIMIT ? OFFSET ?',
      [pageSize, offset]
    );

    res.json({ items, total: totalRow ? totalRow.n : 0, page, pageSize });
  } catch (err) {
    console.error('priority endpoint error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/review/source-progress
 * Returns per-stage totals + pending counts for one source. Drives the
 * progress strip on the Ingest top-tab.
 */
app.get('/api/admin/review/source-progress', async (req, res) => {
  const sourceId = parseInt(req.query.source_id, 10);
  if (!sourceId) return res.status(400).json({ error: 'source_id required' });

  try {
    const db = await getSqliteDb();

    const source = await db.get(
      'SELECT id, title, created_at, added_by FROM sources WHERE id = ?',
      [sourceId]
    );
    if (!source) return res.status(404).json({ error: 'source not found' });

    // Queue (extraction_queue rows for this source)
    const queueRows = await db.all(
      `SELECT status, COUNT(*) AS n
         FROM extraction_queue
        WHERE source_id = ?
        GROUP BY status`,
      [sourceId]
    );
    const queueByStatus = Object.fromEntries(queueRows.map(r => [r.status, r.n]));
    const queueTotal = queueRows.reduce((s, r) => s + r.n, 0);
    const queuePending = (queueByStatus.pending || 0) + (queueByStatus.running || 0) + (queueByStatus.failed || 0);

    // Staging
    const stagingRows = await db.all(
      `SELECT ai_vouch_status, review_status, COUNT(*) AS n
         FROM extraction_staging
        WHERE source_id = ?
        GROUP BY ai_vouch_status, review_status`,
      [sourceId]
    );
    const byVerdict = {};
    let stagingTotal = 0, stagingPending = 0;
    for (const r of stagingRows) {
      stagingTotal += r.n;
      if (r.ai_vouch_status === 'pending' || r.review_status === 'pending') stagingPending += r.n;
      if (r.ai_vouch_status) byVerdict[r.ai_vouch_status] = (byVerdict[r.ai_vouch_status] || 0) + r.n;
    }

    // Entities (joined via claims back to source)
    // UNION subquery lets each arm use the index on claims.source_id; COUNT(DISTINCT CASE …)
    // pushes the 6-clause incompleteness rule into SQL so we never pull entity rows into JS.
    const entityCounts = await db.get(
      `SELECT
         COUNT(DISTINCT e.id) AS total,
         COUNT(DISTINCT CASE
           WHEN e.scientific_name IS NULL
             OR e.bio_category IS NULL
             OR e.taxonomy_path IS NULL
             OR e.primary_role IS NULL
             OR (e.primary_role = 'crop' AND e.crop_type IS NULL)
             OR COALESCE(e.needs_dedup, 0) = 1
           THEN e.id
         END) AS incomplete
       FROM entities e
       WHERE e.id IN (
         SELECT subject_entity_id FROM claims WHERE source_id = ? AND subject_entity_id IS NOT NULL
         UNION
         SELECT object_entity_id  FROM claims WHERE source_id = ? AND object_entity_id  IS NOT NULL
       )`,
      [sourceId, sourceId]
    );
    const entitiesTotal = entityCounts ? entityCounts.total : 0;
    const entitiesIncomplete = entityCounts ? entityCounts.incomplete : 0;

    // Claims
    const claimRows = await db.all(
      `SELECT review_status, COUNT(*) AS n
         FROM claims
        WHERE source_id = ?
        GROUP BY review_status`,
      [sourceId]
    );
    const claimsByStatus = Object.fromEntries(claimRows.map(r => [r.review_status, r.n]));
    const claimsTotal = claimRows.reduce((s, r) => s + r.n, 0);
    const claimsPending = claimsByStatus.ai_reviewed || 0;

    // Entity-trait staging (target_table='entity_trait' rows for this source)
    const traitStagingRows = await db.all(
      `SELECT ai_vouch_status, review_status, COUNT(*) AS n
         FROM extraction_staging
        WHERE source_id = ? AND target_table = 'entity_trait'
        GROUP BY ai_vouch_status, review_status`,
      [sourceId]
    );
    const traitByVerdict = {};
    let traitStagingTotal = 0, traitStagingPending = 0;
    for (const r of traitStagingRows) {
      traitStagingTotal += r.n;
      if (r.ai_vouch_status === 'pending' || r.review_status === 'pending') traitStagingPending += r.n;
      if (r.ai_vouch_status) traitByVerdict[r.ai_vouch_status] = (traitByVerdict[r.ai_vouch_status] || 0) + r.n;
    }

    // Entity-trait claims (entity_trait_claims rows for this source)
    const traitClaimRows = await db.all(
      `SELECT review_status, COUNT(*) AS n
         FROM entity_trait_claims
        WHERE source_id = ?
        GROUP BY review_status`,
      [sourceId]
    );
    const traitClaimsByStatus = Object.fromEntries(traitClaimRows.map(r => [r.review_status, r.n]));
    const traitClaimsTotal = traitClaimRows.reduce((s, r) => s + r.n, 0);
    const traitClaimsPending = (traitClaimsByStatus.unreviewed || 0) +
                                (traitClaimsByStatus.ai_vouched || 0) +
                                (traitClaimsByStatus.ai_reviewed || 0);

    res.json({
      source: { id: source.id, title: source.title, added_at: source.created_at, added_by: source.added_by },
      queue:    { total: queueTotal,    pending: queuePending,    by_status: queueByStatus },
      staging:  { total: stagingTotal,  pending: stagingPending,  by_verdict: byVerdict },
      entities: { total: entitiesTotal, incomplete: entitiesIncomplete },
      claims:   { total: claimsTotal,   pending: claimsPending,   by_status: claimsByStatus },
      entity_trait_staging: { total: traitStagingTotal, pending: traitStagingPending, by_verdict: traitByVerdict },
      entity_traits:        { total: traitClaimsTotal,  pending: traitClaimsPending,  by_status: traitClaimsByStatus }
    });
  } catch (err) {
    console.error('source-progress error', err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── Variety dedup admin routes ────────────────────────────────────────────────

/**
 * GET /api/admin/dedup/varieties
 * Returns dedup candidate pairs grouped by parent species.
 */
app.get('/api/admin/dedup/varieties', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const candidates = await computeCandidates(db);
    res.json({ groups: candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/dedup/varieties/approve
 * Body: { canonicalId, mergedId }
 * Merges mergedId into canonicalId and records in variety_dedup_log.
 */
app.post('/api/admin/dedup/varieties/approve', async (req, res) => {
  try {
    const { canonicalId, mergedId } = req.body;
    if (!canonicalId || !mergedId) return res.status(400).json({ error: 'canonicalId and mergedId are required' });
    const db = await getSqliteDb();
    const logId = await mergeVariety(db, canonicalId, mergedId);
    res.json({ ok: true, logId });
  } catch (err) {
    const status = err.message.includes('not found') ? 400
      : err.message.includes('cross-parent') ? 409
      : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/admin/dedup/varieties/keep-separate
 * Body: { idA, idB }
 * Clears needs_dedup on both entities so they won't resurface as candidates.
 */
app.post('/api/admin/dedup/varieties/keep-separate', async (req, res) => {
  try {
    const { idA, idB } = req.body;
    if (!idA || !idB) return res.status(400).json({ error: 'idA and idB are required' });
    const db = await getSqliteDb();
    await keepSeparate(db, idA, idB);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/dedup/log
 * Returns all variety_dedup_log rows newest-first, including undone entries.
 */
app.get('/api/admin/dedup/log', async (req, res) => {
  try {
    const db = await getSqliteDb();
    const rows = await db.all(`SELECT * FROM variety_dedup_log ORDER BY merged_at DESC`);
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/dedup/undo
 * Body: { logId }
 * Reverses a prior merge; 409 if already undone.
 */
app.post('/api/admin/dedup/undo', async (req, res) => {
  try {
    const { logId } = req.body;
    if (!logId) return res.status(400).json({ error: 'logId is required' });
    const db = await getSqliteDb();
    await unmergeVariety(db, logId);
    res.json({ ok: true });
  } catch (err) {
    const status = err.message.includes('not found') ? 400
      : err.message.includes('already undone') ? 409
      : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Entity dedup admin routes (the review-surface tab) ────────────────────────
app.get('/api/admin/dedup/entities', async (req, res) => {
  try {
    const db = await getSqliteDb();
    res.json({ items: await getReviewQueue(db) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/dedup/entities/approve', async (req, res) => {
  try {
    const { candidateId, canonicalId } = req.body;
    if (!candidateId) return res.status(400).json({ error: 'candidateId is required' });
    const db = await getSqliteDb();
    const { logId } = await approveMerge(db, candidateId, canonicalId);
    res.json({ ok: true, logId });
  } catch (err) {
    const status = err.message.includes('No dedup candidate') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/admin/dedup/entities/keep-separate', async (req, res) => {
  try {
    const { candidateId } = req.body;
    if (!candidateId) return res.status(400).json({ error: 'candidateId is required' });
    const db = await getSqliteDb();
    await keepSeparateEntity(db, candidateId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/dedup/entities/log', async (req, res) => {
  try {
    const db = await getSqliteDb();
    res.json({ items: await getEntityLog(db) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/dedup/entities/undo', async (req, res) => {
  try {
    const { logId } = req.body;
    if (!logId) return res.status(400).json({ error: 'logId is required' });
    const db = await getSqliteDb();
    await unmergeEntity(db, logId);
    res.json({ ok: true });
  } catch (err) {
    const status = err.message.includes('not found') ? 400
      : err.message.includes('already undone') ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────

if (require.main === module) {
app.listen(port, '0.0.0.0', async () => {
  console.log(`✓ AEDIN Backend listening on http://localhost:${port}`);
  // Run stacking schema migration on startup (idempotent — adds columns if missing)
  try {
    const db = await getSqliteDb();
    await migration007.runMigration(db);
    await migration008.runMigration(db);
    await migration009.runMigration(db);
    await migration010.runMigration(db);
    await migration011.runMigration(db);
    await migration012.runMigration(db);
    await migration013.runMigration(db);
    await migration014.runMigration(db);
    await migration015.runMigration(db);
    await migration016.runMigration(db);
    await migration017.runMigration(db);
    await migration018.runMigration(db);
    await migration019.runMigration(db);
    await migration020.runMigration(db);
    await migration024.runMigration(db);
    await migration025.runMigration(db);
    await migration038.runMigration(db);
  } catch (e) {
    console.warn('Migrations skipped:', e.message);
  }
  console.log(`✓ Database: SQLite (aedin.sqlite + ATTACH raw globi.sqlite)`);
  console.log(`✓ Endpoints:`);
  console.log(`  • GET  /api/status`);
  console.log(`  • GET  /api/crops?q=search`);
  console.log(`  • GET  /api/crops/:cropId/interactions`);
  console.log(`  • GET  /api/search?q=query`);
  console.log(`  • GET  /api/categories`);
  console.log(`  • GET  /api/varieties/:cropName?region=X`);
  console.log(`  • POST /api/admin/queue`);
  console.log(`  • GET  /api/admin/queue`);
  console.log(`  • POST /api/admin/queue/run`);
  console.log(`  • GET  /api/admin/staging`);
  console.log(`  • POST /api/admin/staging/:id/approve`);
  console.log(`  • POST /api/admin/staging/:id/reject`);
  console.log(`  • GET  /api/admin/pending-crops`);
  console.log(`  • POST /api/admin/pending-crops/:id/submitted`);
  console.log(`  • GET  /api/site/profile?lat=&lon=`);
  console.log(`  • GET  /api/climate/match?lat=&lon=&role=&crop_id=`);
  console.log(`  • GET  /api/climate/grid?page=&limit=&koppen=&hardiness=&temp_min=&temp_max=`);
});
}

module.exports = app;
