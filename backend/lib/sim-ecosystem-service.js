'use strict';
/** sim-ecosystem-service.js — PURE derivation of per-service categorical ecosystem-service
 *  indicators (Bucket B) from sourced entities facts + designed thresholds. No DB.
 *  Honesty: categorical only; residue = decomposition NOT carbon; biomass = potential proxy
 *  (always designed/low-confidence); no dynamic-accumulator indicator; no single score. */
const D = require('./sim-defaults');
const low = (v) => (v == null || String(v).trim() === '') ? null : String(v).trim().toLowerCase();

function residueDecomposition(cn) {
  const s = low(cn); return s === 'low' ? 'fast' : s === 'medium' ? 'balanced' : s === 'high' ? 'slow_immobilizing' : null;
}
function nutrientDemand(fert, soilNutr) {
  const f = low(fert); if (f) return f;
  if (soilNutr != null) { const n = Number(soilNutr); if (Number.isFinite(n)) return n <= 3 ? 'low' : n <= 6 ? 'medium' : 'high'; }
  return null;
}
function rootingNiche(cm) { if (cm == null) return null; const d = Number(cm); if (!Number.isFinite(d)) return null; return d < D.ROOT_SHALLOW_MAX ? 'shallow' : d > D.ROOT_DEEP_MIN ? 'deep' : 'medium'; }
function growthStrategy(rate) { const s = low(rate); return s === 'rapid' ? 'fast' : s === 'moderate' ? 'moderate' : s === 'slow' ? 'slow' : null; }
function groundCover(habit) { const t = low(habit); if (!t) return null; if (/\bmat|creep|prostrate|trailing|ground.?cover|sprawl/.test(t)) return 'dense'; if (/\bspread|forb|herb|low\b/.test(t)) return 'partial'; return 'none'; }
function lifeCycleClass(lc, habit) { const t = `${low(lc) || ''} ${low(habit) || ''}`; if (/perennial/.test(t)) return 'perennial'; if (/biennial/.test(t)) return 'biennial'; if (/annual/.test(t)) return 'annual'; return null; }
function biomassContribution(h, spread, rate) {
  if (h == null) return null;
  const idx = Number(h) * (D.RATE_FACTOR[low(rate)] || 1);
  return idx < D.BIOMASS_HEIGHT_LOW ? 'low' : idx > D.BIOMASS_HEIGHT_HIGH ? 'high' : 'medium';
}
function soilFunctions({ nitrogen, niche, cover, lifeclass, biomass }) {
  const f = [];
  if (nitrogen && nitrogen !== 'none') f.push('n_fixer');
  if (niche === 'deep') f.push('deep_rooter');
  if (cover === 'dense' || cover === 'partial') f.push('ground_cover');
  if (lifeclass === 'perennial') f.push('perennial_builder');
  if (biomass === 'high') f.push('high_biomass');
  return f;
}
function ecosystemServiceParams(facts) {
  facts = facts || {};
  const inputs = {};
  const rec = (k, v, sourced) => { inputs[k] = { value: v, source: sourced ? 'fact' : 'designed' }; };
  const nitrogen = low(facts.nitrogen_fixation); rec('nitrogen_fixation_class', nitrogen, facts.nitrogen_fixation != null);
  const residue = residueDecomposition(facts.cn_ratio); rec('residue_decomposition', residue, facts.cn_ratio != null);
  const demand = nutrientDemand(facts.fertility_requirement, facts.soil_nutriments); rec('nutrient_demand', demand, facts.fertility_requirement != null || facts.soil_nutriments != null);
  const niche = rootingNiche(facts.min_root_depth_cm); rec('rooting_niche', niche, facts.min_root_depth_cm != null);
  const strategy = growthStrategy(facts.growth_rate); rec('growth_strategy', strategy, facts.growth_rate != null);
  const cover = groundCover(facts.growth_habit); rec('ground_cover', cover, facts.growth_habit != null);
  const lifeclass = lifeCycleClass(facts.life_cycle, facts.growth_habit); rec('life_cycle_class', lifeclass, facts.life_cycle != null || facts.growth_habit != null);
  const biomass = biomassContribution(facts.maximum_height_cm, facts.spread_cm, facts.growth_rate); rec('biomass_contribution', biomass, false); // proxy: always designed
  const fns = soilFunctions({ nitrogen, niche, cover, lifeclass, biomass });
  const sourcedCount = [facts.nitrogen_fixation, facts.cn_ratio, facts.growth_rate, facts.fertility_requirement, facts.min_root_depth_cm].filter((v) => v != null).length;
  const serviceSourced = [facts.nitrogen_fixation, facts.cn_ratio, facts.growth_rate].some((v) => v != null) || facts.min_root_depth_cm != null;
  return {
    nitrogen_fixation_class: nitrogen, residue_decomposition: residue, nutrient_demand: demand,
    rooting_niche: niche, growth_strategy: strategy, ground_cover: cover, life_cycle_class: lifeclass,
    biomass_contribution: biomass, soil_functions: JSON.stringify(fns),
    param_status: serviceSourced ? 'derived' : 'designed',
    derivation_method: 'ecosystem_service_from_facts', model_ref: D.ES_MODEL_REF,
    inputs_json: JSON.stringify(inputs), confidence: sourcedCount >= 3 ? 'high' : sourcedCount >= 1 ? 'medium' : 'low',
  };
}
module.exports = { ecosystemServiceParams };
