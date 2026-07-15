'use strict';
/** sim-scalar-backfill.js — shared fill-if-NULL writer for un-surfaced sim scalar inputs on entities.
 *  Never clobbers a non-NULL value; plantae-only; each applied change → one generic revision_log row +
 *  a backup entry. Reusable by any sim-input source. See sim-data-provenance-policy. */
const { logRevisions } = require('./revision-log');
const ALLOWED = new Set(['maximum_height_cm', 'min_root_depth_cm', 'growth_habit',
  'nitrogen_fixation', 'cn_ratio', 'growth_rate', 'fertility_requirement', 'soil_texture_adaptation',
  'anaerobic_tolerance', 'caco3_tolerance', 'salinity_tolerance', 'drought_tolerance', 'moisture_use',
  'optimal_ph_min', 'optimal_ph_max']);
const NUMERIC_RANGE = { maximum_height_cm: [5, 4000], min_root_depth_cm: [2, 500], optimal_ph_min: [3, 11], optimal_ph_max: [3, 11] };
function saneFor(field, v) {
  if (!ALLOWED.has(field)) return false;
  if (field in NUMERIC_RANGE) { const [lo, hi] = NUMERIC_RANGE[field]; return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }
  return typeof v === 'string' && v.trim() !== '';
}
function applyScalarBackfill(db, plan, { apply = false, changedBy = 'sim-trait-backfill', method = 'sim_trait_backfill' } = {}) {
  const backup = []; let applied = 0, skipped = 0;
  const work = () => {
    for (const p of (plan || [])) {
      if (!p || !saneFor(p.field, p.value)) { skipped++; continue; }
      const row = db.prepare(`SELECT bio_category, ${p.field} AS cur FROM entities WHERE id = ?`).get(p.entity_id);
      if (!row || row.bio_category !== 'plantae' || row.cur != null) { skipped++; continue; }
      backup.push({ entity_id: p.entity_id, field: p.field, before: null, after: p.value });
      if (apply) {
        db.prepare(`UPDATE entities SET ${p.field} = ? WHERE id = ? AND ${p.field} IS NULL`).run(p.value, p.entity_id);
        logRevisions(db, { targetType: 'entity', targetId: p.entity_id, changes: [{ field: p.field, before: null, after: p.value }], changedBy, method });
      }
      applied++;
    }
  };
  if (apply) db.transaction(work)(); else work();
  return { applied, skipped, backup };
}
module.exports = { applyScalarBackfill, saneFor };
