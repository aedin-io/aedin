'use strict';
/** usda-normalize.js — PURE helpers turning USDA PLANTS records into sim inputs + a source adapter. No I/O. */
const FT_TO_CM = 30.48, IN_TO_CM = 2.54;
const HEIGHT_MIN_CM = 5, HEIGHT_MAX_CM = 4000, ROOT_MIN_CM = 2, ROOT_MAX_CM = 500;
function feetToCm(ft) { const n = Number(ft); return Number.isFinite(n) ? +(n * FT_TO_CM).toFixed(1) : null; }
function inchesToCm(inch) { const n = Number(inch); return Number.isFinite(n) ? +(n * IN_TO_CM).toFixed(1) : null; }
function parseHeightFeet(v) {
  if (v == null) return null; const s = String(v).trim();
  if (s === '' || s === '0' || s === '0.0') return null;
  const n = Number(s); if (!Number.isFinite(n) || n <= 0) return null;
  const cm = feetToCm(n); return (cm != null && cm >= HEIGHT_MIN_CM && cm <= HEIGHT_MAX_CM) ? cm : null;
}
function parseRootDepthInches(v) {
  if (v == null) return null; const s = String(v).trim();
  if (s === '' || s === '0') return null;
  const n = Number(s); if (!Number.isFinite(n) || n <= 0) return null;
  const cm = inchesToCm(n); return (cm != null && cm >= ROOT_MIN_CM && cm <= ROOT_MAX_CM) ? cm : null;
}
function composeGrowthHabit(durations, growthHabits) {
  // USDA lists the primary habit/duration first; take only the first of each so a
  // forb-first-then-subshrub plant reads as a herb, not the more-structural subshrub.
  const d = (durations || []).filter(Boolean)[0], h = (growthHabits || []).filter(Boolean)[0];
  const s = [d, h].filter(Boolean).join(' ').trim(); return s || null;
}
function binomial(name) {
  const stripped = String(name || '').replace(/<[^>]+>/g, ' ').toLowerCase();
  return (stripped.match(/[a-z]+/g) || []).slice(0, 2).join(' ');
}
function extractSimFields(characteristics) {
  const out = {};
  for (const c of (characteristics || [])) {
    const n = c && c.PlantCharacteristicName, v = c && c.PlantCharacteristicValue;
    if (n === 'Height, Mature (feet)') { const h = parseHeightFeet(v); if (h != null) out.maximum_height_cm = h; }
    else if (n === 'Root Depth, Minimum (inches)') { const r = parseRootDepthInches(v); if (r != null) out.min_root_depth_cm = r; }
  }
  return out;
}
function dedupeByAcceptedId(plants) {
  const seen = new Map();
  for (const p of plants) { const k = p.AcceptedId || p.Id; if (!seen.has(k)) seen.set(k, p); }
  return [...seen.values()];
}
// A bare species-level name = exactly one italic group of 2 words ("<i>Genus species</i>").
// Infraspecific taxa italicize the infraspecific epithet too (2+ italic groups).
function isBareSpecies(sciName) {
  const italics = (String(sciName || '').match(/<i>(.*?)<\/i>/g) || []).map((x) => x.replace(/<\/?i>/g, '').trim());
  return italics.length === 1 && italics[0].split(/\s+/).filter(Boolean).length === 2;
}
function matchAccepted(searchRows, targetName) {
  const target = binomial(targetName); if (!target) return null;
  const plants = (searchRows || []).map((r) => r && r.Plant).filter(Boolean);
  const hits = plants.filter((p) => binomial(p.AcceptedScientificName || p.ScientificName) === target || binomial(p.ScientificName) === target);
  if (hits.length === 1) return hits[0];
  // USDA returns AcceptedId=0 + a species plus its subspecies/varieties sharing the binomial.
  // Prefer the single bare species-level row; 0 bare (all infraspecific) or >1 bare (genuine homonym) → skip.
  const bare = hits.filter((p) => isBareSpecies(p.ScientificName));
  return bare.length === 1 ? bare[0] : null;
}
// USDA characteristic name → entities field (categorical, lowercased).
const CATEGORICAL = {
  'Nitrogen Fixation': 'nitrogen_fixation', 'C:N Ratio': 'cn_ratio', 'Growth Rate': 'growth_rate',
  'Fertility Requirement': 'fertility_requirement', 'Anaerobic Tolerance': 'anaerobic_tolerance',
  'CaCO3 Tolerance': 'caco3_tolerance', 'Salinity Tolerance': 'salinity_tolerance',
  'Drought Tolerance': 'drought_tolerance', 'Moisture Use': 'moisture_use',
};
const TEXTURE_ROWS = { 'Adapted to Coarse Textured Soils': 'coarse', 'Adapted to Medium Textured Soils': 'medium', 'Adapted to Fine Textured Soils': 'fine' };
function extractServiceFields(characteristics) {
  const out = {}; const textures = [];
  for (const c of (characteristics || [])) {
    const n = c && c.PlantCharacteristicName, v = c && c.PlantCharacteristicValue;
    if (v == null || String(v).trim() === '') continue;
    if (CATEGORICAL[n]) out[CATEGORICAL[n]] = String(v).trim().toLowerCase();
    else if (TEXTURE_ROWS[n] && String(v).trim().toLowerCase() === 'yes') textures.push(TEXTURE_ROWS[n]);
    else if (n === 'pH, Minimum') { const x = Number(v); if (Number.isFinite(x)) out.optimal_ph_min = x; }
    else if (n === 'pH, Maximum') { const x = Number(v); if (Number.isFinite(x)) out.optimal_ph_max = x; }
  }
  if (textures.length) out.soil_texture_adaptation = textures.join(',');
  return out;
}
const adapter = {
  name: 'usda', cacheDir: 'usda-cache',
  extract(record) {
    const fields = extractSimFields(record && record.characteristics);
    Object.assign(fields, extractServiceFields(record && record.characteristics));
    const m = (record && record.matched) || {};
    const habit = composeGrowthHabit(m.Durations, m.GrowthHabits);
    if (habit) fields.growth_habit = habit;
    return { query_name: record && record.query_name, fields };
  },
};
module.exports = { feetToCm, inchesToCm, parseHeightFeet, parseRootDepthInches, composeGrowthHabit,
  binomial, extractSimFields, extractServiceFields, matchAccepted, adapter, HEIGHT_MIN_CM, HEIGHT_MAX_CM, ROOT_MIN_CM, ROOT_MAX_CM };
