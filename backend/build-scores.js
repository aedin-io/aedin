/**
 * build-scores.js
 *
 * Scoring Pipeline — 3 Stages
 *
 * Stage 1: Compute companion_scores from claims + entities
 * Stage 2: Assemble tritrophic_chains from claims
 * Stage 3: Update entity agroeco_functions cache
 *
 * Replaces the old build-companion-scores.js (6-stage pipeline reading raw GloBI).
 *
 * Usage:
 *   node build-scores.js           # incremental (skips if scores exist)
 *   node build-scores.js --clear   # wipe and rebuild
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const CLEAR = process.argv.includes('--clear');

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -65536;
    PRAGMA temp_store = MEMORY;
  `);

  // Always rebuild derived scoring tables (they depend on current claims state)
  console.log('Clearing scoring tables...');
  await db.exec('DELETE FROM companion_scores');
  await db.exec('DELETE FROM tritrophic_chains');
  console.log('  Done.\n');

  // Load entities into memory
  console.log('Loading entities...');
  const entities = await db.all(
    `SELECT id, scientific_name, primary_role, family, nitrogen_fixation, growth_habit
     FROM entities`
  );
  const entityById = new Map(entities.map(e => [e.id, e]));
  const cropIds = new Set(entities.filter(e => e.primary_role === 'crop').map(e => e.id));
  console.log(`  ${entities.length} entities, ${cropIds.size} crops.\n`);

  // ── Stage 1: Compute companion scores ─────────────────────────────────────
  console.log('[Stage 1] Computing companion scores from claims...');

  // Load all non-neutral claims
  const claims = await db.all(`
    SELECT subject_entity_id, object_entity_id,
           applied_weight, impact_class, interaction_type_raw,
           effect_direction, interaction_count, locality_count
    FROM claims
    WHERE applied_weight != 0 OR effect_direction != 'neutral'
  `);
  console.log(`  ${claims.length} scoring-relevant claims loaded.`);

  // Group by (crop_entity_id, companion_entity_id)
  const pairMap = new Map();
  for (const c of claims) {
    const subIsCrop = cropIds.has(c.subject_entity_id);
    const objIsCrop = cropIds.has(c.object_entity_id);

    // At least one must be a crop
    if (!subIsCrop && !objIsCrop) continue;

    // If both are crops, create entries in both directions
    const pairs = [];
    if (subIsCrop) pairs.push({ cropId: c.subject_entity_id, companionId: c.object_entity_id });
    if (objIsCrop) pairs.push({ cropId: c.object_entity_id, companionId: c.subject_entity_id });

    for (const { cropId, companionId } of pairs) {
      if (cropId === companionId) continue; // skip self-loops
      const key = `${cropId}:${companionId}`;
      if (!pairMap.has(key)) pairMap.set(key, { cropId, companionId, claims: [] });
      pairMap.get(key).claims.push(c);
    }
  }
  console.log(`  ${pairMap.size} unique crop-companion pairs.`);

  const scoreStmt = await db.prepare(`
    INSERT OR REPLACE INTO companion_scores
      (crop_entity_id, companion_entity_id, composite_score, raw_score, ceiling_hit,
       score_breakdown, total_claims, dominant_valence, top_interaction_types,
       structural_complement, has_threshold_warning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let scoreCount = 0;
  await db.exec('BEGIN');

  for (const [, pair] of pairMap) {
    const { cropId, companionId, claims: pairClaims } = pair;
    const crop = entityById.get(cropId);
    const companion = entityById.get(companionId);
    if (!crop || !companion) continue;

    const baseWeightedSum = pairClaims.reduce((s, c) => s + (c.applied_weight || 0), 0);

    const totalClaims = pairClaims.length;
    const normalizer = Math.max(totalClaims, 3);

    const baseRaw = baseWeightedSum / normalizer;

    // Bonuses are normalized into [0,1] so they don't dwarf or vanish as totalClaims varies.
    const isLegume = companion.family === 'Fabaceae' || companion.family === 'Leguminosae';
    const hasNFix = companion.nitrogen_fixation && companion.nitrogen_fixation !== 'none';
    const legumeBonus = (isLegume || hasNFix) ? 0.2 : 0;

    const structComplement = (crop.growth_habit && companion.growth_habit &&
      crop.growth_habit !== companion.growth_habit) ? 1 : 0;
    const structuralBonus = structComplement * 0.05;

    const rawScore = baseRaw + legumeBonus + structuralBonus;
    const clamped = Math.max(-1, Math.min(1, rawScore));
    const ceilingHit = Math.abs(rawScore) > 1 ? 1 : 0;

    const hasThresholdWarning = pairClaims.some(c => c.impact_class === 'threshold') ? 1 : 0;
    const compositeScore = hasThresholdWarning ? -0.8 : clamped;

    // Dominant valence
    let pos = 0, neg = 0;
    const typeCounts = {};
    for (const c of pairClaims) {
      if (c.effect_direction === 'beneficial') pos++;
      else if (c.effect_direction === 'harmful') neg++;
      typeCounts[c.interaction_type_raw] = (typeCounts[c.interaction_type_raw] || 0) + 1;
    }
    const dominantValence = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
    const topTypes = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);

    const breakdown = {
      base_weighted_sum: baseWeightedSum,
      base_normalized: baseRaw,
      legume_bonus: legumeBonus,
      structural_bonus: structuralBonus,
      structural_complement: !!structComplement,
      normalizer,
      raw_score: rawScore,
      ceiling_hit: !!ceilingHit,
      positive_claims: pos,
      negative_claims: neg,
      threshold_override: !!hasThresholdWarning,
    };

    await scoreStmt.run(
      cropId, companionId, compositeScore, rawScore, ceilingHit,
      JSON.stringify(breakdown), totalClaims,
      dominantValence, JSON.stringify(topTypes), structComplement, hasThresholdWarning
    );

    scoreCount++;
    if (scoreCount % 10000 === 0) {
      await db.exec('COMMIT');
      await db.exec('BEGIN');
      console.log(`  Scored ${scoreCount}...`);
    }
  }

  await db.exec('COMMIT');
  await scoreStmt.finalize();

  const stats = await db.get(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN composite_score >= 0.7 THEN 1 ELSE 0 END) AS strong,
      SUM(CASE WHEN composite_score BETWEEN 0.3 AND 0.7 THEN 1 ELSE 0 END) AS moderate,
      SUM(CASE WHEN composite_score < -0.3 THEN 1 ELSE 0 END) AS caution
    FROM companion_scores
  `);
  console.log(`\nStage 1 complete: ${scoreCount} pairs scored.`);
  console.log(`  Strong (≥0.7): ${stats.strong}`);
  console.log(`  Moderate (0.3–0.7): ${stats.moderate}`);
  console.log(`  Caution (<-0.3): ${stats.caution}\n`);

  // ── Stage 2: Tritrophic chains ────────────────────────────────────────────
  console.log('[Stage 2] Assembling tritrophic chains...');

  const ACTION_VERBS = {
    parasitoidOf: 'parasitizes', preysOn: 'preys on',
    eats: 'feeds on', kills: 'kills'
  };

  const chainRows = await db.all(`
    SELECT
      c_pest.object_entity_id   AS crop_entity_id,
      c_pest.subject_entity_id  AS pest_entity_id,
      c_ctrl.subject_entity_id  AS beneficial_entity_id,
      c_pest.interaction_type_raw AS pest_interaction_type,
      c_ctrl.interaction_type_raw AS control_interaction_type,
      c_pest.interaction_count  AS pest_record_count,
      c_ctrl.interaction_count  AS control_record_count,
      c_pest.locality_count     AS pest_locality_count,
      c_ctrl.locality_count     AS control_locality_count,
      e_crop.scientific_name    AS crop_name,
      e_pest.scientific_name    AS pest_name,
      e_ben.scientific_name     AS beneficial_name
    FROM claims c_pest
    JOIN claims c_ctrl
      ON c_ctrl.object_entity_id = c_pest.subject_entity_id
      AND c_ctrl.interaction_category = 'biocontrol'
    JOIN entities e_crop ON e_crop.id = c_pest.object_entity_id
    JOIN entities e_pest ON e_pest.id = c_pest.subject_entity_id
    JOIN entities e_ben  ON e_ben.id = c_ctrl.subject_entity_id
    WHERE c_pest.effect_direction = 'harmful'
      AND e_crop.primary_role = 'crop'
      -- pathogen_viral kept as fallback for un-refined entries; phytopathogen_viral
      -- is the host-context-aware refinement (Phase-1.5 fix); entomopathogen_viral
      -- is INTENTIONALLY excluded from the pest set — those are baculoviruses etc.,
      -- which are biocontrol agents of pest insects, not pests of crops. See
      -- lib/entity-name-classification.js for the role split.
      AND e_pest.primary_role IN ('pest_insect', 'pest_mite', 'pest_vertebrate',
                                   'pathogen_fungal', 'pathogen_bacterial',
                                   'pathogen_viral', 'phytopathogen_viral',
                                   'pathogen_nematode')
      AND e_ben.primary_role IN ('biocontrol', 'beneficial_predator', 'beneficial_parasitoid',
                                  'entomopathogen_viral')
    GROUP BY c_pest.object_entity_id, c_pest.subject_entity_id, c_ctrl.subject_entity_id
  `);

  const chainStmt = await db.prepare(`
    INSERT OR REPLACE INTO tritrophic_chains
      (crop_entity_id, pest_entity_id, beneficial_entity_id,
       pest_interaction_type, control_interaction_type,
       pest_record_count, control_record_count,
       pest_locality_count, control_locality_count,
       confidence_level, sentence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let chainCount = 0;
  await db.exec('BEGIN');
  for (const r of chainRows) {
    const minRec = Math.min(r.pest_record_count, r.control_record_count);
    const minLoc = Math.min(r.pest_locality_count, r.control_locality_count);
    const confidence = minRec >= 10 && minLoc >= 3 ? 'strong'
      : minRec >= 5 || minLoc >= 2 ? 'moderate' : 'weak';

    const verb = ACTION_VERBS[r.control_interaction_type] || 'controls';
    const sentence = `Your ${r.crop_name} is attacked by ${r.pest_name}. ` +
      `${r.beneficial_name} ${verb} ${r.pest_name}. ` +
      `Confidence: ${confidence} (${minRec} records, ${minLoc} regions).`;

    await chainStmt.run(
      r.crop_entity_id, r.pest_entity_id, r.beneficial_entity_id,
      r.pest_interaction_type, r.control_interaction_type,
      r.pest_record_count, r.control_record_count,
      r.pest_locality_count, r.control_locality_count,
      confidence, sentence
    );
    chainCount++;
  }
  await db.exec('COMMIT');
  await chainStmt.finalize();
  console.log(`  ${chainCount} tritrophic chains assembled.\n`);

  // ── Stage 3: Update entity agroeco_functions ──────────────────────────────
  console.log('[Stage 3] Updating entity agroeco_functions...');

  // Helper to add a function to an entity's agroeco_functions
  async function addFunction(entityId, func) {
    const row = await db.get('SELECT agroeco_functions FROM entities WHERE id = ?', entityId);
    const funcs = row?.agroeco_functions ? JSON.parse(row.agroeco_functions) : [];
    if (!funcs.includes(func)) {
      funcs.push(func);
      await db.run('UPDATE entities SET agroeco_functions = ? WHERE id = ?', [JSON.stringify(funcs), entityId]);
    }
  }

  // Nitrogen fixers: entities with nitrogen_fixation != 'none' or Fabaceae family
  const nFixers = await db.all(`
    SELECT id FROM entities
    WHERE (nitrogen_fixation IS NOT NULL AND nitrogen_fixation != 'none')
      OR family IN ('Fabaceae', 'Leguminosae')
  `);
  for (const { id } of nFixers) {
    await addFunction(id, 'nitrogen_fixer');
  }

  // Pollinator habitat: crop entities that are objects of pollination claims
  const pollinatorHabitats = await db.all(`
    SELECT DISTINCT c.object_entity_id AS eid
    FROM claims c
    JOIN entities e ON e.id = c.object_entity_id
    WHERE c.interaction_category = 'pollination' AND e.primary_role = 'crop'
  `);
  for (const { eid } of pollinatorHabitats) {
    await addFunction(eid, 'pollinator_habitat');
  }

  // Insectary: crops/wild_plants with positive companion_scores from predators/parasitoids
  const insectaryPlants = await db.all(`
    SELECT DISTINCT cs.crop_entity_id AS eid
    FROM companion_scores cs
    JOIN entities e ON e.id = cs.companion_entity_id
    WHERE e.primary_role IN ('biocontrol', 'beneficial_predator', 'beneficial_parasitoid')
      AND cs.composite_score >= 0.3
  `);
  for (const { eid } of insectaryPlants) {
    await addFunction(eid, 'insectary');
  }

  // Trap crop: entities that are subjects of trap_crop claims (if any exist)
  const trapCrops = await db.all(`
    SELECT DISTINCT subject_entity_id AS eid
    FROM claims WHERE interaction_category = 'trap_crop'
  `);
  for (const { eid } of trapCrops) {
    await addFunction(eid, 'trap_crop');
  }

  const funcStats = await db.get(`
    SELECT COUNT(*) AS n FROM entities WHERE agroeco_functions IS NOT NULL AND agroeco_functions != '[]'
  `);
  console.log(`  ${funcStats.n} entities have agroeco_functions populated.\n`);

  console.log('Pipeline complete.');
  await db.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
