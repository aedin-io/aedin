'use strict';
/** trefle-normalize.js — PURE helpers turning a Trefle species record into sim inputs + a source adapter. No I/O.
 *  Trefle heights/roots are already in cm; growth habit from duration + specifications.growth_habit|growth_form. */
const HEIGHT_MIN_CM = 5, HEIGHT_MAX_CM = 4000, ROOT_MIN_CM = 2, ROOT_MAX_CM = 500;
function saneCm(v, lo, hi) { const n = Number(v); return (Number.isFinite(n) && n >= lo && n <= hi) ? +n.toFixed(1) : null; }
function composeGrowthHabit(duration, habit, form) {
  const s = [duration, habit || form].filter(Boolean).join(' ').trim(); return s || null;
}
function extractFromSpecies(data) {
  data = data || {}; const specs = data.specifications || {}, growth = data.growth || {};
  const out = {};
  const hCm = (specs.maximum_height || {}).cm != null ? (specs.maximum_height || {}).cm : (specs.average_height || {}).cm;
  const h = saneCm(hCm, HEIGHT_MIN_CM, HEIGHT_MAX_CM); if (h != null) out.maximum_height_cm = h;
  const r = saneCm((growth.minimum_root_depth || {}).cm, ROOT_MIN_CM, ROOT_MAX_CM); if (r != null) out.min_root_depth_cm = r;
  const habit = composeGrowthHabit(data.duration, specs.growth_habit, specs.growth_form); if (habit) out.growth_habit = habit;
  return out;
}
function binomial(name) { return (String(name || '').toLowerCase().match(/[a-z]+/g) || []).slice(0, 2).join(' '); }
function matchSpecies(searchRows, targetName) {
  const target = binomial(targetName); if (!target) return null;
  return (searchRows || []).find((p) => p && binomial(p.scientific_name) === target) || null;
}
const adapter = {
  name: 'trefle', cacheDir: 'trefle-sim-cache',
  extract(record) { return { query_name: record && record.query_name, fields: extractFromSpecies(record && record.matched) }; },
};
module.exports = { composeGrowthHabit, extractFromSpecies, binomial, matchSpecies, adapter,
  HEIGHT_MIN_CM, HEIGHT_MAX_CM, ROOT_MIN_CM, ROOT_MAX_CM };
