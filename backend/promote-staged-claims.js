'use strict';

/**
 * Phase 2 — staging → claims bridge.
 *
 * Lifts AI-vouched rows from `extraction_staging` into the live `claims`
 * table with full provenance. Implements the headless replacement for
 * what the original Phase-4 review UI was supposed to do for the
 * AI-only execution path described in `docs/phased-roadmap-ai-only.md`.
 *
 * Eligibility criteria
 * --------------------
 * Default (strict, AI-only-doctrine): target_table='interactions' OR
 *   target_table='crop_vulnerabilities', ai_vouch_status='plausible',
 *   review_status NOT IN ('promoted','rejected'), AND the multi-critic
 *   consensus gate (claim_critic_verdicts >= 2 plausible / 0 implausible)
 *   is met. Until the multi-critic table exists, default mode promotes
 *   ZERO rows — by design, so the gate is honest.
 *
 * --allow-single-vouch: also promote on single-critic ai_vouch_status=
 *   'plausible'. Promoted with claims.review_status='ai_vouched' (NOT
 *   ai_reviewed). Useful for dev / sandbox / pre-multi-critic
 *   pilots. The serving-layer gate excludes 'ai_vouched' from public
 *   responses (those rows stay internal-only).
 *
 * --dry-run: report what would be promoted; write nothing.
 * --limit N: cap the number of staging rows processed (default: no cap).
 *
 * Idempotency
 * -----------
 * Each promoted staging row has its `review_status` set to 'promoted'
 * with `reviewed_at` timestamped. Re-runs skip already-promoted rows.
 *
 * Usage
 * -----
 *   node promote-staged-claims.js --dry-run
 *   node promote-staged-claims.js --allow-single-vouch
 *   node promote-staged-claims.js --allow-single-vouch --limit 25
 */

const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { pickGlobiTerm } = require('./backfill-globi-interaction-type');
const { loadVocabulary, validateClaimAgainstVocab } = require('./lib/trait-vocabulary');
const { encodeTraitValue } = require('./lib/trait-value');
const { INTERACTION_CATEGORIES, reconcileVectorCategory } = require('./lib/interaction-vocabulary');
const { normalizeVarietyName } = require('./lib/variety-normalize');
const { classifyTaxonomicResolution } = require('./lib/taxonomic-resolution');
const { hasResolvableLocality } = require('./lib/region-normalize');
const { isCoarseRankName } = require('./lib/taxon-rank-floor');
const { cropSlotVerdict } = require('./lib/crop-entity-type-gate');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ALLOW_SINGLE = args.includes('--allow-single-vouch');
// Optional source scoping (comma-separated ids). Absent = unchanged global behavior.
// Lets a session promote only its own freshly-ingested sources without sweeping
// in another concurrent session's consensus-ready rows. Values are parsed ints
// (no SQL-injection surface).
const SRC_IDS = ((args.find(a => a.startsWith('--source-id=')) || '').split('=')[1] || '')
  .split(',').map(s => parseInt(s, 10)).filter(Boolean);
const srcClause = (alias) => SRC_IDS.length ? ` AND ${alias}source_id IN (${SRC_IDS.join(',')})` : '';
const LIMIT_IDX = args.indexOf('--limit');
const LIMIT = LIMIT_IDX >= 0 ? parseInt(args[LIMIT_IDX + 1], 10) : null;

// Map extractor's interaction_type → claims.interaction_category.
// Single source of truth lives in lib/interaction-vocabulary.js so additions
// (e.g. new attractor categories) propagate without drift here.
const VALID_INTERACTION_CATEGORIES = INTERACTION_CATEGORIES;

// Damage types from crop_vulnerabilities payloads map directly to category.
const VALID_DAMAGE_TYPES = new Set(['pest_pressure', 'pathogen_pressure', 'herbivory']);

// Negative-evidence (migration 056): how an absence was established. Lenient —
// an unrecognized basis is nulled, the claim still promotes (the observed_absence
// flag is the load-bearing bit; the basis is descriptive provenance).
const ABSENCE_BASES = new Set([
  'no_choice_trial', 'choice_trial', 'field_survey_absent',
  'explicit_non_host', 'resistance_screen',
]);

// Read negative-evidence fields off a payload. Returns {observedAbsence, absenceBasis}.
// observedAbsence is 0/1; absenceBasis is null unless observedAbsence and the basis
// is in the controlled vocab.
function readAbsence(payload) {
  const isAbsent = payload.observed_absence === true || payload.observed_absence === 1
    || payload.observed_absence === 'true';
  if (!isAbsent) return { observedAbsence: 0, absenceBasis: null };
  const basis = typeof payload.absence_basis === 'string' ? payload.absence_basis.trim() : null;
  return { observedAbsence: 1, absenceBasis: ABSENCE_BASES.has(basis) ? basis : null };
}

// Coevolution structure of a host-pathogen/parasite claim (migration 060). Lenient:
// an unrecognized value is nulled. gene_for_gene flags a race-specific interaction
// the prediction layer must not generalize across cultivars/regions.
const COEVOLUTION_VALUES = new Set(['gene_for_gene', 'quantitative', 'unknown']);
function readCoevolution(payload) {
  const v = typeof payload.coevolution_structure === 'string' ? payload.coevolution_structure.trim() : null;
  return COEVOLUTION_VALUES.has(v) ? v : null;
}

const RESISTANCE_LEVELS = new Set(['complete', 'strong', 'partial', 'tolerant']);
function readResistanceLevel(payload) {
  const v = typeof payload.resistance_level === 'string' ? payload.resistance_level.trim().toLowerCase() : null;
  return RESISTANCE_LEVELS.has(v) ? v : null;
}

function pickField(payload, ...candidates) {
  for (const k of candidates) {
    if (payload[k] !== undefined && payload[k] !== null && payload[k] !== '') {
      return payload[k];
    }
  }
  return null;
}

async function getOrCreateEntity(db, scientificName) {
  if (!scientificName || typeof scientificName !== 'string') return null;
  const trimmed = scientificName.trim();
  if (!trimmed) return null;

  let row = await db.get(
    'SELECT id, scientific_name, bio_category, primary_role FROM entities WHERE scientific_name = ? COLLATE NOCASE',
    [trimmed]
  );
  if (row) return row;

  await db.run(
    `INSERT OR IGNORE INTO entities
       (scientific_name, bio_category, primary_role, source_table, data_completeness, taxonomic_resolution, created_at, updated_at)
     VALUES (?, 'other', 'unclassified', 'extraction_staging', 'minimal', ?, datetime('now'), datetime('now'))`,
    [trimmed, classifyTaxonomicResolution(trimmed)]
  );
  row = await db.get(
    'SELECT id, scientific_name, bio_category, primary_role FROM entities WHERE scientific_name = ? COLLATE NOCASE',
    [trimmed]
  );
  return row || null;
}

/**
 * Resolve the entity that a claim should attach to, given a scientific name
 * and optional variety name.
 *
 * - If variety_name is null/empty → returns the species entity (existing
 *   getOrCreateEntity behavior).
 * - If variety_name is set → looks up the variety entity under the species's
 *   parent_entity_id. If not found, auto-creates it with needs_dedup=1.
 *
 * variety_name is normalized via lib/variety-normalize before lookup, so
 * "  Solar Fire™  " and "Solar Fire" resolve to the same entity.
 */
async function resolveEntityForClaim(db, scientificName, varietyName) {
  if (!scientificName || typeof scientificName !== 'string') return null;
  const sciTrimmed = scientificName.trim();
  if (!sciTrimmed) return null;

  // 1. Resolve or create the parent species entity (existing logic)
  const parent = await getOrCreateEntity(db, sciTrimmed);
  if (!parent) return null;

  // 2. If no variety, attach claim at species level
  const normalized = normalizeVarietyName(varietyName);
  if (!normalized) return parent;

  // 3. Look up existing variety entity under this parent
  let variety = await db.get(
    `SELECT id, scientific_name, bio_category, primary_role FROM entities
     WHERE parent_entity_id = ? AND variety_name = ? COLLATE NOCASE`,
    [parent.id, normalized]
  );
  if (variety) return variety;

  // 4. Auto-create with needs_dedup=1
  // Build compound scientific_name: "<species> '<cultivar>'" so the inline UNIQUE
  // constraint on entities.scientific_name (inherited from migration 008) doesn't
  // reject distinct cultivars under the same parent species. The bare species
  // scientific_name is preserved via parent_entity_id, not duplicated here.
  const compoundSci = `${sciTrimmed} '${normalized}'`;
  await db.run(
    `INSERT INTO entities
       (scientific_name, common_name, variety_name, parent_entity_id, bio_category,
        primary_role, source_table, data_completeness, needs_dedup, taxonomic_resolution,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'extraction_staging', 'minimal', 1, 'species',
             datetime('now'), datetime('now'))`,
    [
      compoundSci,
      parent.common_name || null,
      normalized,
      parent.id,
      parent.bio_category || 'plantae',
      parent.primary_role || 'unclassified',
    ]
  );
  variety = await db.get(
    `SELECT id, scientific_name, bio_category, primary_role FROM entities
     WHERE parent_entity_id = ? AND variety_name = ? COLLATE NOCASE`,
    [parent.id, normalized]
  );
  return variety;
}

async function buildReferenceCitation(db, sourceId) {
  if (!sourceId) return null;
  const src = await db.get(
    'SELECT title, authors, year FROM sources WHERE id = ?',
    [sourceId]
  );
  if (!src) return null;
  const authors = src.authors || 'Unknown';
  const year = src.year || 'n.d.';
  const title = src.title || 'Untitled';
  return `${authors} (${year}). ${title}.`;
}

function mapPayloadToClaim(stagingRow, payload) {
  const targetTable = stagingRow.target_table;

  if (targetTable === 'interactions') {
    const subjectName = pickField(payload, 'subject_organism', 'subject_crop');
    const objectName = pickField(payload, 'object_organism', 'object_crop');
    const interactionType = payload.interaction_type;
    const effectDirection = payload.effect_direction || 'beneficial';
    const sourceQuote = payload.source_quote || null;
    const sourcePage = payload.source_page != null ? Number(payload.source_page) : null;
    const mechanism = payload.mechanism || null;

    if (!VALID_INTERACTION_CATEGORIES.has(interactionType)) {
      return { skip: true, reason: `unknown interaction_type: ${interactionType}` };
    }

    return {
      subjectName,
      objectName,
      interactionTypeRaw: interactionType,
      interactionCategory: interactionType,
      effectDirection,
      sourceQuote,
      sourcePage,
      mechanism,
      severityClass: null,
      regionalContext: payload.regional_context || null,
      ...readAbsence(payload),
      coevolutionStructure: readCoevolution(payload),
      resistanceLevel: readResistanceLevel(payload),
    };
  }

  if (targetTable === 'crop_vulnerabilities') {
    // pest acts on crop → subject=pest, object=crop.
    const subjectName = pickField(payload, 'pest_scientific_name', 'pest_organism');
    const objectName = pickField(payload, 'crop', 'crop_scientific_name');
    const damageType = payload.damage_type || 'pest_pressure';
    const category = VALID_DAMAGE_TYPES.has(damageType) ? damageType : 'pest_pressure';

    return {
      subjectName,
      objectName,
      interactionTypeRaw: damageType,
      interactionCategory: category,
      effectDirection: 'harmful',
      sourceQuote: payload.source_quote || null,
      sourcePage: payload.source_page != null ? Number(payload.source_page) : null,
      mechanism: payload.affected_part ? `${damageType} on ${payload.affected_part}` : null,
      severityClass: payload.severity || null,
      regionalContext: payload.regional_context || null,
      ...readAbsence(payload),
      coevolutionStructure: readCoevolution(payload),
    };
  }

  if (targetTable === 'attractor_relationship') {
    const subjectName = pickField(payload, 'subject_organism', 'subject_crop');
    const objectName = pickField(payload, 'object_organism', 'object_crop');
    const interactionType = payload.interaction_category || 'attracts_natural_enemy';

    if (!VALID_INTERACTION_CATEGORIES.has(interactionType)) {
      return { skip: true, reason: `unknown interaction_category: ${interactionType}` };
    }

    return {
      subjectName,
      objectName,
      interactionTypeRaw: interactionType,
      interactionCategory: interactionType,
      effectDirection: 'beneficial',
      sourceQuote: payload.source_quote || null,
      sourcePage: payload.source_page != null ? Number(payload.source_page) : null,
      mechanism: payload.mechanism || null,
      severityClass: payload.impact_class || null,
      regionalContext: payload.regional_context || null,
      // Attractor/support relationships are inherently positive — absence N/A,
      // and they are not host-pathogen pairs — coevolution structure N/A.
      observedAbsence: 0,
      absenceBasis: null,
      coevolutionStructure: null,
    };
  }

  return { skip: true, reason: `unhandled target_table: ${targetTable}` };
}

// ---------------------------------------------------------------------------
// entity_trait promotion
// ---------------------------------------------------------------------------

let _vocabCache = null;

// Growth/morphology/maturity traits are meaningful only on crop anchors. Gate
// them so a crop-guide extractor can't mis-attach them to a pest or weed named
// in the source. Deliberately NARROW: pest/beneficial traits (voltinism,
// thermal_min, generations_per_year) and general plant descriptors (life_cycle,
// growth_habit) are intentionally NOT gated.
const CROP_ANCHORED_TRAITS = new Set([
  'maximum_height_cm', 'average_height_cm', 'canopy_spread_cm',
  'in_row_spacing_cm', 'between_row_spacing_cm', 'days_to_harvest',
]);

async function _vocab(db) {
  if (!_vocabCache) _vocabCache = await loadVocabulary(db);
  return _vocabCache;
}

/**
 * Promote a single entity_trait staging row into entity_trait_claims.
 * Called externally (tests) and from the main loop below for
 * target_table='entity_trait' rows.
 *
 * Returns { skip: true, reason } or { skip: false, entity_id }.
 */
async function promoteEntityTraitRow(db, stagingRow) {
  const payload = JSON.parse(stagingRow.payload);
  const vocab = await _vocab(db);
  const v = vocab[payload.trait_name];
  if (!v) return { skip: true, reason: `unknown trait: ${payload.trait_name}` };

  // validateClaimAgainstVocab expects value_json as a JSON string (it calls
  // JSON.parse internally), but extractor payloads carry it as a parsed object.
  // Normalize to string for the validator, then restore the object form below.
  const claimForValidation = { ...payload };
  if (claimForValidation.value_json !== null && claimForValidation.value_json !== undefined
      && typeof claimForValidation.value_json !== 'string') {
    claimForValidation.value_json = JSON.stringify(claimForValidation.value_json);
  }
  const validation = validateClaimAgainstVocab(vocab, claimForValidation);
  if (!validation.ok) return { skip: true, reason: validation.reason || validation.error };

  const entity = await resolveEntityForClaim(db, payload.scientific_name, payload.variety_name);
  if (!entity) return { skip: true, reason: `entity not found: ${payload.scientific_name}` };

  // Crop-gate: crop-anchored growth traits must attach to a crop entity.
  if (CROP_ANCHORED_TRAITS.has(payload.trait_name)) {
    const anchor = await db.get(`SELECT crop_type, edible FROM entities WHERE id = ?`, [entity.id]);
    if (!anchor || (anchor.crop_type == null && anchor.edible != 1)) {
      return { skip: true, reason: `crop-gate: ${payload.trait_name} requires a crop anchor (crop_type/edible), got ${payload.scientific_name}` };
    }
  }

  // Pick the raw value from whichever value_* field the payload filled.
  let raw;
  if (v.value_kind === 'numeric') raw = payload.value_numeric;
  else if (v.value_kind === 'categorical') raw = payload.value_text;
  else if (v.value_kind === 'boolean') raw = payload.value_text === 'true' || payload.value_text === true;
  else if (v.value_kind === 'range') raw = payload.value_json;
  else if (v.value_kind === 'list') raw = payload.value_json;

  const enc = encodeTraitValue(v, raw);

  // Source-type-dependent gate: human_verified supersedes prior readings.
  const src = await db.get(`SELECT source_type FROM sources WHERE id = ?`, [stagingRow.source_id]);
  const sourceType = src?.source_type || 'unknown';

  let reviewStatus = 'ai_reviewed';
  if (sourceType === 'human_verified') {
    reviewStatus = 'human_verified';
    // Mark prior non-human_verified readings for the same (entity, trait)
    // as superseded. We set superseded_by after the insert so we have the
    // new row's id; for now just flag them with a sentinel (NULL superseded_by
    // rows will be updated once we know the new id).
    await db.run(
      `UPDATE entity_trait_claims
         SET superseded_by = -1
       WHERE entity_id = ? AND trait_name = ? AND review_status != 'human_verified'`,
      [entity.id, payload.trait_name]
    );
  }

  const result = await db.run(
    `INSERT OR IGNORE INTO entity_trait_claims (
       entity_id, trait_name, value_numeric, value_text, value_json, unit,
       source_id, source_quote, source_page, regional_context,
       review_status, ai_vouch_status, staging_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'plausible', ?, datetime('now'))`,
    [
      entity.id, payload.trait_name,
      enc.value_numeric, enc.value_text, enc.value_json, payload.unit || null,
      stagingRow.source_id, payload.source_quote || null, payload.source_page ?? null,
      payload.regional_context || null,
      reviewStatus,
      stagingRow.id,
    ]
  );

  // Resolve sentinel: point superseded rows at the new row's id.
  if (sourceType === 'human_verified' && result.lastID) {
    await db.run(
      `UPDATE entity_trait_claims
         SET superseded_by = ?
       WHERE entity_id = ? AND trait_name = ? AND superseded_by = -1`,
      [result.lastID, entity.id, payload.trait_name]
    );
  }

  await db.run(
    `UPDATE extraction_staging SET review_status='promoted', reviewed_at=datetime('now') WHERE id = ?`,
    [stagingRow.id]
  );

  return { skip: false, entity_id: entity.id };
}

/**
 * Decide the entity FKs + resolution status for a promoted claim. Prefers any
 * id the legacy promotion resolver already found; otherwise falls back to the
 * PostRAG-resolved id from the staging row.
 */
function claimEntityFields(staging, { subjectId, objectId }) {
  return {
    subject_entity_id: subjectId != null ? subjectId : (staging.resolved_subject_entity_id ?? null),
    object_entity_id: objectId != null ? objectId : (staging.resolved_object_entity_id ?? null),
    entity_resolution_status: staging.entity_resolution_status ?? null,
  };
}

module.exports.promoteEntityTraitRow = promoteEntityTraitRow;
module.exports._resetVocabCache = () => { _vocabCache = null; };
module.exports.resolveEntityForClaim = resolveEntityForClaim;
module.exports.claimEntityFields = claimEntityFields;
module.exports.mapPayloadToClaim = mapPayloadToClaim;
module.exports.readAbsence = readAbsence;
module.exports.readCoevolution = readCoevolution;
module.exports.readResistanceLevel = readResistanceLevel;

// Guard the CLI promotion run so importing this module (tests, batch-prepare)
// does NOT execute a live promotion against globi.sqlite. Runs only when the
// file is invoked directly: `node promote-staged-claims.js`.
if (require.main === module) (async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Build the eligibility query. Default mode requires consensus, but
  // until claim_critic_verdicts exists this clause cannot match — by design.
  // --allow-single-vouch relaxes to single-vouch plausible.
  let stagingRows;
  if (ALLOW_SINGLE) {
    let sql = `
      SELECT id, target_table, source_id, payload, ai_vouch_status, review_status,
             resolved_subject_entity_id, resolved_object_entity_id, entity_resolution_status
      FROM extraction_staging
      WHERE ai_vouch_status = 'plausible'
        AND target_table IN ('interactions', 'crop_vulnerabilities', 'entity_trait', 'attractor_relationship')
        AND (review_status IS NULL OR review_status NOT IN ('promoted', 'rejected'))${srcClause('')}
      ORDER BY id
    `;
    if (LIMIT) sql += ` LIMIT ${LIMIT}`;
    stagingRows = await db.all(sql);
  } else {
    // Strict mode: require multi-critic consensus. The claim_critic_verdicts
    // table is part of the upcoming Phase 2.5 work — not yet built — so this
    // intentionally returns 0 rows today.
    const hasConsensusTable = await db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='claim_critic_verdicts'"
    );
    if (!hasConsensusTable) {
      stagingRows = [];
      console.log('[promote] strict mode requires claim_critic_verdicts table (Phase 2.5 work).');
      console.log('[promote] No multi-critic consensus available yet → 0 candidates.');
      console.log('[promote] Use --allow-single-vouch for the pre-multi-critic dev path.');
    } else {
      let sql = `
        SELECT s.id, s.target_table, s.source_id, s.payload, s.ai_vouch_status, s.review_status,
               s.resolved_subject_entity_id, s.resolved_object_entity_id, s.entity_resolution_status,
               COUNT(CASE WHEN cv.verdict = 'plausible'   THEN 1 END) AS plausible_count,
               COUNT(CASE WHEN cv.verdict = 'implausible' THEN 1 END) AS implausible_count
        FROM extraction_staging s
        JOIN claim_critic_verdicts cv ON cv.staging_id = s.id
        WHERE s.target_table IN ('interactions', 'crop_vulnerabilities', 'entity_trait', 'attractor_relationship')
          AND (s.review_status IS NULL OR s.review_status NOT IN ('promoted', 'rejected'))${srcClause('s.')}
        GROUP BY s.id
        HAVING plausible_count >= 2 AND implausible_count = 0
        ORDER BY s.id
      `;
      if (LIMIT) sql += ` LIMIT ${LIMIT}`;
      stagingRows = await db.all(sql);
    }
  }

  console.log(`[promote] mode=${ALLOW_SINGLE ? 'single-vouch' : 'consensus'} dry_run=${DRY_RUN} candidates=${stagingRows.length}`);

  let promoted = 0;
  let skipped = 0;
  const reasons = {};

  if (!DRY_RUN) await db.exec('BEGIN');

  for (const row of stagingRows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch (err) {
      reasons['bad_json'] = (reasons['bad_json'] || 0) + 1;
      skipped++;
      continue;
    }

    // entity_trait rows go to a dedicated function that writes entity_trait_claims.
    if (row.target_table === 'entity_trait') {
      if (DRY_RUN) { promoted++; continue; }
      const etResult = await promoteEntityTraitRow(db, row);
      if (etResult.skip) {
        reasons[etResult.reason] = (reasons[etResult.reason] || 0) + 1;
        skipped++;
      } else {
        promoted++;
      }
      continue;
    }

    // attractor_relationship rows map to claims exactly like interactions rows
    // (mapPayloadToClaim handles them via the interactions branch; the
    // interaction_category values are already in VALID_INTERACTION_CATEGORIES).
    const claim = mapPayloadToClaim(row, payload);
    if (claim.skip) {
      reasons[claim.reason] = (reasons[claim.reason] || 0) + 1;
      skipped++;
      continue;
    }

    if (!claim.subjectName || !claim.objectName) {
      reasons['missing_organism_name'] = (reasons['missing_organism_name'] || 0) + 1;
      skipped++;
      continue;
    }

    // Locality policy: a promoted INTERACTION claim must resolve to >=1 locality
    // (scope or country). regionalContext is mapped from payload.regional_context.
    // Note: entity_trait rows are intentionally exempt — an intrinsic species
    // trait (edible_part, life_cycle, thermal_min...) is not regional, so those
    // rows are promoted by promoteEntityTraitRow above and `continue` before
    // reaching this gate. See the no-locality regression test.
    if (!hasResolvableLocality(claim.regionalContext)) {
      reasons['no_locality'] = (reasons['no_locality'] || 0) + 1;
      skipped++;
      continue;
    }

    if (!claim.sourceQuote) {
      // The serving-layer gate requires source_quote — promoting without one
      // would create rows that fail the gate. Skip rather than silently emit.
      reasons['no_source_quote'] = (reasons['no_source_quote'] || 0) + 1;
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      promoted++;
      continue;
    }

    const subj = await resolveEntityForClaim(db, claim.subjectName, payload.subject_variety);
    const obj = await resolveEntityForClaim(db, claim.objectName,
      payload.object_variety || payload.crop_variety);
    if (!subj || !obj) {
      reasons['entity_creation_failed'] = (reasons['entity_creation_failed'] || 0) + 1;
      skipped++;
      continue;
    }

    // Rank-floor policy: reject a claim whose subject or object resolves no
    // finer than CLASS (Insecta, Acari="Mites", Nematoda, Plantae...). Such
    // endpoints are too coarse for any downstream inference. Family/genus
    // collectives (Aphididae, "spider mites"→Tetranychidae) pass the floor.
    // See lib/taxon-rank-floor.js for the policy rationale.
    if (isCoarseRankName(subj.scientific_name) || isCoarseRankName(obj.scientific_name)) {
      reasons['coarse_rank'] = (reasons['coarse_rank'] || 0) + 1;
      skipped++;
      continue;
    }

    // Crop entity-type gate (field_mislabel extraction-error class, 2026-06-16):
    // a crop_vulnerabilities claim's crop (the object) must be a plant. Reject only a
    // CONFIRMED animal in the crop slot (bio_category animal AND a real animal kingdom) —
    // an animal tag with an unconfirmed kingdom is the entity-taxonomy-corruption bug
    // (e.g. Lycopersicon esculentum mis-tagged invertebrate) and must NOT be rejected.
    // See lib/crop-entity-type-gate.js + audit-crop-slot-types.js.
    if (row.target_table === 'crop_vulnerabilities') {
      const objTax = await db.get('SELECT kingdom FROM entities WHERE id = ?', obj.id);
      if (!cropSlotVerdict(obj.bio_category, objTax && objTax.kingdom).allowed) {
        reasons['crop_slot_not_plant'] = (reasons['crop_slot_not_plant'] || 0) + 1;
        skipped++;
        continue;
      }
    }

    const referenceCitation = await buildReferenceCitation(db, row.source_id);

    const reviewStatus = ALLOW_SINGLE ? 'ai_vouched' : 'ai_reviewed';

    // applied_weight gates whether downstream public endpoints surface
    // the claim at all (they filter `applied_weight != 0` to drop neutral
    // GloBI rows). Mirror that semantic for bridge-promoted claims:
    // beneficial/harmful effects get magnitude 1.0; neutral/context_dependent
    // stay at 0 (the effect direction itself encodes valence elsewhere).
    // Negative-evidence (migration 056): an observed_absence is a true negative —
    // force weight 0 so it never surfaces in positive-interaction views. It lives
    // only as a calibration/training signal for the prediction layer.
    const appliedWeight = claim.observedAbsence ? 0.0
      : (claim.effectDirection === 'beneficial' || claim.effectDirection === 'harmful') ? 1.0 : 0.0;

    // GloBI Relations Ontology term for the claim. Prefer the LLM-extracted
    // value (post-2026-05-07 extractor.md updates emit it directly into the
    // staging payload). Fall back to the heuristic mapping for older
    // extractions or when the LLM didn't supply one. See
    // docs/globi-trefle-alignment.md for the mapping table.
    const interactionTypeGlobi = payload.interaction_type_globi
      || pickGlobiTerm(claim.interactionCategory, subj.bio_category, obj.bio_category, subj.primary_role);

    // A vectorOf claim must categorize as disease_vector, never the force-fit
    // pathogen_pressure/pest_pressure (see lib/interaction-vocabulary.js).
    claim.interactionCategory = reconcileVectorCategory(claim.interactionCategory, interactionTypeGlobi);

    const fields = claimEntityFields(row, { subjectId: subj.id, objectId: obj.id });

    const result = await db.run(
      `INSERT INTO claims (
         subject_entity_id, object_entity_id, source_id, data_tier,
         interaction_type_raw, interaction_category, interaction_type_globi,
         effect_direction,
         confidence_score, applied_weight, evidence_tier,
         valence_confidence, resolution_path,
         mechanism, impact_class,
         interaction_count, locality_count,
         source_quote, source_page,
         country, subdivision,
         regional_context,
         reference_citation,
         review_status, reviewer_id, reviewed_at,
         staging_id,
         entity_resolution_status,
         observed_absence, absence_basis,
         coevolution_structure,
         resistance_level,
         created_at
       ) VALUES (?, ?, ?, 'tier1_paper', ?, ?, ?, ?, ?, ?, 'direct',
                 'direct', ?, ?, ?, 1, 0,
                 ?, ?, '', '',
                 ?, ?, ?, 'promote-staged-claims', datetime('now'),
                 ?, ?,
                 ?, ?,
                 ?, ?,
                 datetime('now'))`,
      [
        fields.subject_entity_id, fields.object_entity_id, row.source_id,
        claim.interactionTypeRaw, claim.interactionCategory, interactionTypeGlobi,
        claim.effectDirection,
        payload.confidence_score != null ? payload.confidence_score : 0.7,
        appliedWeight,
        `Promoted from staging row ${row.id} (vouch=${row.ai_vouch_status}, mode=${ALLOW_SINGLE ? 'single' : 'consensus'})`,
        claim.mechanism, claim.severityClass,
        claim.sourceQuote, claim.sourcePage,
        claim.regionalContext,
        referenceCitation,
        reviewStatus,
        row.id,
        fields.entity_resolution_status,
        claim.observedAbsence ?? 0, claim.absenceBasis ?? null,
        claim.coevolutionStructure ?? null,
        claim.resistanceLevel ?? null,
      ]
    );

    await db.run(
      `UPDATE extraction_staging
         SET review_status = 'promoted', review_note = ?, reviewed_at = datetime('now')
       WHERE id = ?`,
      [`promoted to claims.id=${result.lastID} (mode=${ALLOW_SINGLE ? 'single' : 'consensus'})`, row.id]
    );

    promoted++;
  }

  if (!DRY_RUN) await db.exec('COMMIT');

  await db.close();

  console.log(`[promote] promoted=${promoted} skipped=${skipped}`);
  if (Object.keys(reasons).length) {
    console.log('[promote] skip reasons:');
    for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
  }
})().catch(err => {
  console.error('promote-staged-claims failed:', err);
  process.exit(1);
});
