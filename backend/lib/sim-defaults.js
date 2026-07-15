'use strict';
/**
 * sim-defaults.js — DESIGNED constants for the sim-params layer. Every default
 * is tagged with a versioned model_ref so a regenerated row records which
 * constant-set produced it. These are modelling choices, NOT measurements — a
 * horticulturist plausibility pass is expected. Bump *_v<N> when constants change.
 */
const GROWTH_MODEL_REF = 'growth_v2';
const PEST_MODEL_REF = 'pest_v1';
const BIOCONTROL_MODEL_REF = 'biocontrol_v1';
const VISUAL_MODEL_REF = 'visual_v1';

// Designed growth envelope per life_form. Herbaceous forms grow over DAYS;
// woody/long-lived forms over YEARS (days_to_maturity is then a year count).
const LIFE_FORM_DEFAULTS = {
  annual_herb:    { time_unit: 'days',  max_height_cm: 60,  max_spread_cm: 40,  max_root_depth_cm: 40,  days_to_maturity: 90,  height_curve_model: 'logistic',          canopy_layer: 'herb',   light_extinction_coeff: 0.5 },
  perennial_herb: { time_unit: 'days',  max_height_cm: 80,  max_spread_cm: 60,  max_root_depth_cm: 60,  days_to_maturity: 120, height_curve_model: 'logistic',          canopy_layer: 'herb',   light_extinction_coeff: 0.5 },
  grass:          { time_unit: 'days',  max_height_cm: 100, max_spread_cm: 50,  max_root_depth_cm: 80,  days_to_maturity: 100, height_curve_model: 'logistic',          canopy_layer: 'herb',   light_extinction_coeff: 0.4 },
  vine:           { time_unit: 'days',  max_height_cm: 200, max_spread_cm: 100, max_root_depth_cm: 50,  days_to_maturity: 110, height_curve_model: 'logistic',          canopy_layer: 'shrub',  light_extinction_coeff: 0.6 },
  geophyte:       { time_unit: 'days',  max_height_cm: 40,  max_spread_cm: 30,  max_root_depth_cm: 30,  days_to_maturity: 120, height_curve_model: 'logistic',          canopy_layer: 'herb',   light_extinction_coeff: 0.5 },
  shrub:          { time_unit: 'years', max_height_cm: 300, max_spread_cm: 200, max_root_depth_cm: 100, days_to_maturity: 3,   height_curve_model: 'perennial_seasonal', canopy_layer: 'shrub',  light_extinction_coeff: 0.6 },
  tree:           { time_unit: 'years', max_height_cm: 800, max_spread_cm: 500, max_root_depth_cm: 350, days_to_maturity: 18,  height_curve_model: 'perennial_seasonal', canopy_layer: 'canopy', light_extinction_coeff: 0.7 },
  unclassified:   { time_unit: 'days',  max_height_cm: 60,  max_spread_cm: 40,  max_root_depth_cm: 40,  days_to_maturity: 100, height_curve_model: 'logistic',          canopy_layer: 'herb',   light_extinction_coeff: 0.5 },
};

// Designed suppression fraction (0-1) by natural-enemy guild.
const CONTROL_MAGNITUDE = { parasitoid: 0.4, predator: 0.35, pathogen: 0.35, generalist: 0.25, unknown: 0.2 };
const BIOCONTROL_DEFAULTS = { response_lag_days: 14, establishment: 'resident', specificity: 'unknown' };

// Generic pest phenology (refined when voltinism / generations facts exist).
const PEST_DEFAULTS = { generations_per_year: 2, onset_season: 'spring', pressure_buildup_rate: 0.3, peak_pressure: 0.8, overwintering: 'unknown' };

// Designed minimum rooting depth = MIN_ROOT_DEPTH_FRACTION × designed max, used
// only when no minimum root depth is sourced (USDA/Trefle). The sim samples a
// rooting depth in [min, max].
const MIN_ROOT_DEPTH_FRACTION = 0.4;

// Ecosystem-service (Bucket B) designed thresholds. Modelling choices; horticulturist-checkable.
const ES_MODEL_REF = 'es_v1';
const ROOT_SHALLOW_MAX = 30;   // < 30 cm = shallow niche
const ROOT_DEEP_MIN = 100;     // > 100 cm = deep niche
const BIOMASS_HEIGHT_LOW = 100;   // rate-adjusted height cm bands for the biomass proxy
const BIOMASS_HEIGHT_HIGH = 400;
const RATE_FACTOR = { slow: 0.7, moderate: 1, rapid: 1.3 };

// canopy_layer from a KNOWN height (cm).
function canopyLayerForHeight(cm) {
  if (cm == null) return null;
  if (cm < 30) return 'ground';
  if (cm < 150) return 'herb';
  if (cm < 400) return 'shrub';
  if (cm < 1500) return 'canopy';
  return 'emergent';
}

module.exports = {
  GROWTH_MODEL_REF, PEST_MODEL_REF, BIOCONTROL_MODEL_REF, VISUAL_MODEL_REF,
  LIFE_FORM_DEFAULTS, CONTROL_MAGNITUDE, BIOCONTROL_DEFAULTS, PEST_DEFAULTS, MIN_ROOT_DEPTH_FRACTION, canopyLayerForHeight,
  ES_MODEL_REF, ROOT_SHALLOW_MAX, ROOT_DEEP_MIN, BIOMASS_HEIGHT_LOW, BIOMASS_HEIGHT_HIGH, RATE_FACTOR,
};
