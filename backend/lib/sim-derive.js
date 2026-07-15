'use strict';
/**
 * sim-derive.js — PURE derivation functions for the sim-params layer (no DB).
 * Turns sourced facts + designed defaults (lib/sim-defaults.js) into typed
 * sim_* rows, each tagged param_status. Consumed by backend/derive-sim-params.js
 */
const D = require('./sim-defaults');

// growth_habit is free-text prose, so life_form is a keyword classifier, not a
// lookup. Most-specific/structural form wins; herbs split by life cycle.
const FORM_KEYWORDS = [
  { life_form: 'tree',     re: /\btree\b|\btimber\b|\boverstory\b/i },
  { life_form: 'shrub',    re: /\bshrub|\bbush\b|\bsubshrub\b|\bhedgerow\b/i },
  { life_form: 'geophyte', re: /\bgeophyte\b|\btuber|\bcorm\b|\brhizom|\bbulb/i },
  { life_form: 'vine',     re: /\bvine\b|\bclimb|\bliana\b|\btwin(?:e|ing)\b/i },
  { life_form: 'grass',    re: /\bgrass\b|\bcereal\b|\bgraminoid\b|\bbunchgrass\b|\btussock\b|\bsod\b|\bbamboo\b/i },
  { life_form: 'herb',     re: /\bherb|\bforb\b|\brosette\b|\bsucculent\b|\bvegetable\b|\bcreeping\b|\bprostrate\b|\bground.?cover\b|\btrailing\b|\bsprawl|\bmat.forming\b/i },
];
const PERENNIAL_RE = /\bperennial\b/i;
const ANNUAL_RE = /\bannual\b|\bbiennial\b/i;

function classifyLifeForm(growthHabit, lifeCycle, family) {
  const text = [growthHabit, lifeCycle, family].filter(Boolean).join(' ; ');
  const matched = [];
  let base = null;
  for (const k of FORM_KEYWORDS) {
    if (k.re.test(text)) { base = k.life_form; matched.push(k.life_form); break; }
  }
  if (!base) return { lifeForm: 'unclassified', matched };
  if (base !== 'herb') return { lifeForm: base, matched };
  const perennial = PERENNIAL_RE.test(text);
  const annual = ANNUAL_RE.test(text);
  const lifeForm = perennial && !annual ? 'perennial_herb' : 'annual_herb';
  matched.push(perennial && !annual ? 'perennial' : 'annual');
  return { lifeForm, matched };
}

const ARCHETYPE_BY_LIFEFORM = {
  tree: 'single_stem_tree', shrub: 'bushy_shrub', vine: 'vine_trellis', grass: 'grass_clump',
  geophyte: 'root_mound', annual_herb: 'leafy_rosette', perennial_herb: 'leafy_rosette', unclassified: 'leafy_rosette',
};
const CANOPY_SHAPE_BY_LIFEFORM = {
  tree: 'spherical', shrub: 'spherical', vine: 'spreading', grass: 'columnar',
  geophyte: 'irregular', annual_herb: 'spreading', perennial_herb: 'spreading', unclassified: 'irregular',
};

function deriveSeasonality(facts, lifeForm) {
  const det = (facts.growth_determinacy || '').toLowerCase();
  if (det.includes('indetermin')) return 'indeterminate_annual';
  if (det.includes('determin')) return 'determinate_annual';
  if (lifeForm === 'tree' || lifeForm === 'shrub' || lifeForm === 'perennial_herb') {
    return /deciduous/i.test(facts.life_cycle || '') ? 'deciduous_perennial' : 'evergreen_perennial';
  }
  return 'determinate_annual';
}

function growthCurveParams(facts, lifeFormInfo) {
  const lf = lifeFormInfo.lifeForm;
  const def = D.LIFE_FORM_DEFAULTS[lf] || D.LIFE_FORM_DEFAULTS.unclassified;
  const inputs = {};
  const pick = (factVal, defVal, key) => {
    if (factVal != null) { inputs[key] = { value: factVal, source: 'fact' }; return { value: factVal, sourced: true }; }
    inputs[key] = { value: defVal, source: 'designed:' + D.GROWTH_MODEL_REF }; return { value: defVal, sourced: false };
  };
  const height = pick(facts.max_height_cm, def.max_height_cm, 'max_height_cm');
  const spread = pick(facts.max_spread_cm, def.max_spread_cm, 'max_spread_cm');
  // days_to_harvest is a DAYS value, meaningless for woody forms whose curve runs
  // over YEARS (spec F1) — only source it for day-scaled life_forms; woody forms
  // keep the designed years value.
  const maturityFact = def.time_unit === 'days' ? facts.days_to_harvest : null;
  const maturity = pick(maturityFact, def.days_to_maturity, 'days_to_maturity');
  const root = pick(facts.max_root_depth_cm, def.max_root_depth_cm, 'max_root_depth_cm');
  // Root depth is a RANGE the sim samples within: sourced minimum where present,
  // else a designed fraction of the designed max. Keep min <= max.
  let maxDepth = root.value, minDepth;
  if (facts.min_root_depth_cm != null) {
    minDepth = facts.min_root_depth_cm;
    if (minDepth > maxDepth) maxDepth = Math.ceil(minDepth * 1.25); // trust the sourced floor
    inputs.min_root_depth_cm = { value: minDepth, source: 'fact' };
  } else {
    minDepth = Math.round(maxDepth * D.MIN_ROOT_DEPTH_FRACTION);
    inputs.min_root_depth_cm = { value: minDepth, source: 'designed:' + D.GROWTH_MODEL_REF };
  }

  const M = Math.max(maturity.value, 1); // guard: non-positive days_to_maturity would make curve params Infinity/negative
  const inflection = +(0.5 * M).toFixed(2);
  const rate = +(8 / M).toFixed(4); // logistic reaches ~99.7% near maturity
  const status = height.sourced ? 'derived' : 'designed';
  const factCount = [height, spread, maturity, root].filter((x) => x.sourced).length + (facts.min_root_depth_cm != null ? 1 : 0);
  const confidence = factCount >= 2 ? 'high' : (factCount === 1 ? 'medium' : 'low');

  return {
    life_form: lf, time_unit: def.time_unit,
    max_height_cm: height.value, max_spread_cm: spread.value,
    max_root_depth_cm: maxDepth, min_root_depth_cm: minDepth, root_pattern: facts.root_architecture || null,
    days_to_maturity: M,
    height_curve_model: def.height_curve_model, height_inflection: inflection, height_rate_k: rate,
    spread_curve_model: def.height_curve_model, spread_inflection: inflection, spread_rate_k: rate,
    canopy_layer: D.canopyLayerForHeight(height.value) || def.canopy_layer,
    seasonality: deriveSeasonality(facts, lf),
    light_extinction_coeff: def.light_extinction_coeff,
    param_status: status, derivation_method: 'growth_curve_from_facts_and_defaults',
    model_ref: D.GROWTH_MODEL_REF, inputs_json: JSON.stringify(inputs), confidence,
  };
}

function visualMapping(growthRow, facts) {
  const lf = growthRow.life_form;
  const hasProduce = facts.produce_color != null;
  return {
    model_archetype: ARCHETYPE_BY_LIFEFORM[lf] || 'leafy_rosette',
    canopy_shape: CANOPY_SHAPE_BY_LIFEFORM[lf] || 'irregular',
    foliage_color: 'green',
    produce_color: facts.produce_color || null,
    height_scale_cm: growthRow.max_height_cm, spread_scale_cm: growthRow.max_spread_cm,
    param_status: hasProduce ? 'derived' : 'designed',
    derivation_method: 'visual_from_life_form', model_ref: D.VISUAL_MODEL_REF,
    inputs_json: JSON.stringify({ life_form: lf, produce_color: facts.produce_color || null }),
    confidence: hasProduce ? 'medium' : 'low',
  };
}

function voltinismToGenerations(v) {
  const s = String(v).toLowerCase();
  if (s.includes('univoltine')) return 1;
  if (s.includes('bivoltine')) return 2;
  if (s.includes('multivoltine') || s.includes('polyvoltine')) return 4;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function pestDynamics(facts) {
  facts = facts || {};
  const inputs = {};
  let gens, status;
  if (facts.generations_per_year != null) {
    gens = facts.generations_per_year; inputs.generations_per_year = { value: gens, source: 'fact' }; status = 'derived';
  } else if (facts.voltinism != null && voltinismToGenerations(facts.voltinism) != null) {
    gens = voltinismToGenerations(facts.voltinism); inputs.voltinism = { value: facts.voltinism, source: 'fact' }; status = 'derived';
  } else {
    gens = D.PEST_DEFAULTS.generations_per_year; inputs.generations_per_year = { value: gens, source: 'designed:' + D.PEST_MODEL_REF }; status = 'designed';
  }
  return {
    generations_per_year: gens,
    onset_season: facts.favorable_season || D.PEST_DEFAULTS.onset_season,
    onset_months: facts.activity_months || null,
    pressure_buildup_rate: D.PEST_DEFAULTS.pressure_buildup_rate,
    peak_pressure: D.PEST_DEFAULTS.peak_pressure,
    overwintering: facts.survival_structure || D.PEST_DEFAULTS.overwintering,
    param_status: status, derivation_method: 'pest_phenology_from_facts_and_defaults',
    model_ref: D.PEST_MODEL_REF, inputs_json: JSON.stringify(inputs),
    confidence: status === 'derived' ? 'medium' : 'low',
  };
}

function guildOf(edge) {
  const role = String(edge.enemy_primary_role || '').toLowerCase();
  if (role.includes('parasitoid') || role.includes('parasite')) return 'parasitoid';
  if (role.includes('predator')) return 'predator';
  if (role.includes('pathogen') || role.includes('entomopath')) return 'pathogen';
  if (role.includes('beneficial') || role.includes('biocontrol')) return 'generalist';
  return 'unknown';
}

function biocontrolDefaults(edge) {
  edge = edge || {};
  const guild = guildOf(edge);
  const mag = D.CONTROL_MAGNITUDE[guild] != null ? D.CONTROL_MAGNITUDE[guild] : D.CONTROL_MAGNITUDE.unknown;
  return {
    control_magnitude: mag,
    response_lag_days: D.BIOCONTROL_DEFAULTS.response_lag_days,
    establishment: edge.commercial_biocontrol ? 'augmentative' : D.BIOCONTROL_DEFAULTS.establishment,
    specificity: edge.enemy_diet_breadth || D.BIOCONTROL_DEFAULTS.specificity,
    param_status: 'designed', derivation_method: 'biocontrol_default_by_guild',
    model_ref: D.BIOCONTROL_MODEL_REF, inputs_json: JSON.stringify({ guild, commercial_biocontrol: !!edge.commercial_biocontrol }),
    confidence: 'low',
  };
}

module.exports = { classifyLifeForm, growthCurveParams, visualMapping, pestDynamics, biocontrolDefaults, voltinismToGenerations };
