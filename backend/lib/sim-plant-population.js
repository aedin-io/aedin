'use strict';
/** sim-plant-population.js — the distinct plant names the sim cascade tries to fill:
 *  sim-eligible plantae still missing at least one target scalar. Shared by every source fetcher. */
function fillableNames(db) {
  return db.prepare(`
    SELECT DISTINCT scientific_name FROM entities
    WHERE scope_tier IS NOT NULL AND bio_category='plantae'
      AND ( crop_type IS NOT NULL OR edible=1
            OR id IN (SELECT entity_id FROM entity_trait_claims WHERE review_status='ai_reviewed'
                      AND trait_name IN ('maximum_height_cm','average_height_cm','in_row_spacing_cm',
                          'between_row_spacing_cm','days_to_harvest','growth_habit','life_cycle','root_architecture')) )
      AND ( maximum_height_cm IS NULL OR growth_habit IS NULL OR min_root_depth_cm IS NULL
            OR nitrogen_fixation IS NULL OR cn_ratio IS NULL OR growth_rate IS NULL OR fertility_requirement IS NULL )
    ORDER BY scientific_name
  `).all().map((r) => r.scientific_name).filter(Boolean);
}
module.exports = { fillableNames };
