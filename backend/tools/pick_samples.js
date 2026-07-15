const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });

  const counts = {};
  for (const t of ['tritrophic_chains', 'beneficial_chains', 'anticipated_interactions', 'companion_scores', 'claims', 'entities']) {
    counts[t] = (await db.get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
  }

  const org = await db.get(`
    SELECT id, scientific_name, common_name, family, taxonomy_path, bio_category, primary_role, organism_type, agroeco_functions, crop_type, edible, nitrogen_fixation
    FROM entities
    WHERE primary_role IS NOT NULL AND primary_role != ''
      AND scientific_name IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 1
  `);

  const pair = await db.get(`
    SELECT
      cs.id, cs.composite_score, cs.total_claims, cs.dominant_valence,
      cs.top_interaction_types, cs.structural_complement, cs.has_threshold_warning, cs.score_breakdown,
      ca.scientific_name AS crop_name, ca.common_name AS crop_common, ca.family AS crop_family, ca.bio_category AS crop_bio, ca.primary_role AS crop_role,
      cb.scientific_name AS companion_name, cb.common_name AS companion_common, cb.family AS companion_family, cb.bio_category AS companion_bio, cb.primary_role AS companion_role
    FROM companion_scores cs
    JOIN entities ca ON ca.id = cs.crop_entity_id
    JOIN entities cb ON cb.id = cs.companion_entity_id
    WHERE cs.composite_score > 0.5 AND cs.total_claims >= 3
    ORDER BY cs.composite_score DESC, cs.total_claims DESC
    LIMIT 1
  `);

  const claimsCols = (await db.all(`PRAGMA table_info(claims)`)).map(c => c.name);

  let triple = null;
  if (counts.tritrophic_chains > 0) {
    triple = await db.get(`
      SELECT tc.*,
        ca.scientific_name AS crop_name, ca.common_name AS crop_common,
        cp.scientific_name AS pest_name, cp.common_name AS pest_common,
        cb.scientific_name AS beneficial_name, cb.common_name AS beneficial_common
      FROM tritrophic_chains tc
      JOIN entities ca ON ca.id = tc.crop_entity_id
      JOIN entities cp ON cp.id = tc.pest_entity_id
      JOIN entities cb ON cb.id = tc.beneficial_entity_id
      ORDER BY tc.control_record_count DESC
      LIMIT 1
    `);
  } else {
    triple = await db.get(`
      SELECT
        crop.scientific_name AS crop_name, crop.common_name AS crop_common, crop.bio_category AS crop_bio,
        pest.scientific_name AS pest_name, pest.common_name AS pest_common, pest.bio_category AS pest_bio, pest.primary_role AS pest_role,
        pred.scientific_name AS predator_name, pred.common_name AS predator_common, pred.bio_category AS predator_bio, pred.primary_role AS predator_role,
        c1.interaction_type_raw AS pest_vs_crop, c1.effect_direction AS pest_effect, c1.extracted_claim AS pest_claim,
        c2.interaction_type_raw AS pred_vs_pest, c2.effect_direction AS pred_effect, c2.extracted_claim AS pred_claim
      FROM claims c1
      JOIN claims c2 ON c2.object_entity_id = c1.subject_entity_id
      JOIN entities crop ON crop.id = c1.object_entity_id
      JOIN entities pest ON pest.id = c1.subject_entity_id
      JOIN entities pred ON pred.id = c2.subject_entity_id
      WHERE c1.effect_direction = 'harmful'
        AND c2.effect_direction = 'harmful'
        AND crop.bio_category = 'plantae'
        AND pest.bio_category = 'invertebrate'
        AND pred.bio_category = 'invertebrate'
        AND crop.id <> pest.id AND crop.id <> pred.id AND pest.id <> pred.id
      LIMIT 1
    `);
  }

  console.log(JSON.stringify({ counts, organism: org, companion_pair: pair, tritrophic_triple_source: counts.tritrophic_chains > 0 ? 'tritrophic_chains' : 'constructed_from_claims', tritrophic_triple: triple, claimsCols }, null, 2));
  await db.close();
})();
