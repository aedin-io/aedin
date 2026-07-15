const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, coverageConfidence } = require('./site-profile');

test('haversineKm: zero distance for identical points', () => {
  assert.equal(haversineKm(36.65, -121.80, 36.65, -121.80), 0);
});

test('haversineKm: ~111 km per degree of latitude near the equator', () => {
  const d = haversineKm(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111.19) < 0.5, `expected ~111.19, got ${d}`);
});

test('haversineKm: known short distance Salinas → matched cell center', () => {
  // (36.65, -121.80) query → (36.75, -121.75) cell center.
  // Hand-computed haversine ≈ 12.3 km.
  const d = haversineKm(36.65, -121.80, 36.75, -121.75);
  assert.ok(d > 11.5 && d < 13.0, `expected ~12.3, got ${d}`);
});

test('haversineKm: antipodal points ≈ half Earth circumference', () => {
  const d = haversineKm(0, 0, 0, 180);
  assert.ok(Math.abs(d - 20015) < 5, `expected ~20015, got ${d}`);
});

test('coverageConfidence: 0 km → exact', () => {
  assert.equal(coverageConfidence(0), 'exact');
});

test('coverageConfidence: 14 km (boundary) → exact', () => {
  assert.equal(coverageConfidence(14), 'exact');
});

test('coverageConfidence: 14.001 km → nearby', () => {
  assert.equal(coverageConfidence(14.001), 'nearby');
});

test('coverageConfidence: 50 km (boundary) → nearby', () => {
  assert.equal(coverageConfidence(50), 'nearby');
});

test('coverageConfidence: 50.001 km → distant', () => {
  assert.equal(coverageConfidence(50.001), 'distant');
});

test('coverageConfidence: 500 km → distant', () => {
  assert.equal(coverageConfidence(500), 'distant');
});

const { parseLatLon } = require('./site-profile');

test('parseLatLon: valid numeric strings → ok', () => {
  assert.deepEqual(parseLatLon('36.65', '-121.80'), { ok: true, lat: 36.65, lon: -121.80 });
});

test('parseLatLon: valid numbers → ok', () => {
  assert.deepEqual(parseLatLon(0, 0), { ok: true, lat: 0, lon: 0 });
});

test('parseLatLon: missing lat → error', () => {
  const r = parseLatLon(undefined, '0');
  assert.equal(r.ok, false);
  assert.match(r.error, /lat/);
});

test('parseLatLon: missing lon → error', () => {
  const r = parseLatLon('0', undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /lon/);
});

test('parseLatLon: non-numeric lat → error', () => {
  const r = parseLatLon('abc', '0');
  assert.equal(r.ok, false);
  assert.match(r.error, /lat/);
});

test('parseLatLon: non-numeric lon → error', () => {
  const r = parseLatLon('0', 'xyz');
  assert.equal(r.ok, false);
  assert.match(r.error, /lon/);
});

test('parseLatLon: lat out of range high → error', () => {
  const r = parseLatLon('95', '0');
  assert.equal(r.ok, false);
  assert.match(r.error, /lat/);
});

test('parseLatLon: lat out of range low → error', () => {
  const r = parseLatLon('-91', '0');
  assert.equal(r.ok, false);
});

test('parseLatLon: lon out of range → error', () => {
  const r = parseLatLon('0', '-200');
  assert.equal(r.ok, false);
  assert.match(r.error, /lon/);
});

test('parseLatLon: lat at boundary 90 → ok', () => {
  assert.deepEqual(parseLatLon('90', '0'), { ok: true, lat: 90, lon: 0 });
});

test('parseLatLon: lon at boundary -180 → ok', () => {
  assert.deepEqual(parseLatLon('0', '-180'), { ok: true, lat: 0, lon: -180 });
});

const { buildSiteProfile } = require('./site-profile');

// A fully-populated climate_grid row, matching the schema verified at
// backend/_cols_check.js (id..soil_depth_bedrock_cm). Numeric values are
// representative of Salinas Valley, CA and are NOT used for assertions on
// real-world accuracy — only for shape and pass-through correctness.
function fullRow() {
  return {
    id: 12345,
    lat: 36.75,
    lon: -121.75,
    elevation_m: 42,
    monthly_temp_high: '[18.1,19.0,19.8,20.5,21.2,22.0,22.5,22.6,22.0,20.8,19.2,18.0]',
    monthly_temp_low:  '[7.2,7.8,8.5,9.1,10.4,12.0,13.1,13.0,12.0,10.5,8.5,7.1]',
    monthly_precip_mm: '[88,75,62,31,12,4,1,2,7,22,48,60]',
    monthly_humidity:  '[72,71,70,69,68,70,73,74,73,72,72,73]',
    bio1_annual_mean_temp: 14.2,
    bio2_mean_diurnal_range: 9.8,
    bio3_isothermality: 52.1,
    bio4_temp_seasonality: 412,
    bio5_max_temp_warmest: 26.1,
    bio6_min_temp_coldest: 3.9,
    bio7_temp_annual_range: 22.2,
    bio8_mean_temp_wettest_q: 9.8,
    bio9_mean_temp_driest_q: 19.6,
    bio10_mean_temp_warmest_q: 19.6,
    bio11_mean_temp_coldest_q: 8.9,
    bio12_annual_precip: 412,
    bio13_precip_wettest_month: 88,
    bio14_precip_driest_month: 1,
    bio15_precip_seasonality: 68,
    bio16_precip_wettest_q: 223,
    bio17_precip_driest_q: 4,
    bio18_precip_warmest_q: 7,
    bio19_precip_coldest_q: 211,
    frost_free_days: 298,
    growing_degree_days: 2480,
    first_frost_doy: 320,
    last_frost_doy: 38,
    koppen_zone: 'Csb',
    hardiness_zone: '9b',
    soil_ph_surface: 6.5,
    soil_clay_pct: 28.0,
    soil_sand_pct: 37.0,
    soil_organic_carbon: 21.0,
    soil_moisture_index: 0.42,
    soil_silt_pct: 35.0,
    soil_cec: 18.7,
    soil_nitrogen: 1.8,
    soil_bulk_density: 1.32,
    soil_coarse_fragments_pct: 8.5,
    soil_water_field_capacity: 28.2,
    soil_water_wilting_point: 12.1,
    soil_available_water: 16.1,
    monthly_solar_radiation: '[10,12,15,18,21,23,22,20,17,14,11,9]',
    mean_solar_radiation: 16.8,
    monthly_vapor_pressure: '[0.9,1.0,1.1,1.2,1.2,1.2,1.2,1.2,1.1,1.0,1.0,0.9]',
    mean_vapor_pressure: 1.12,
    mean_relative_humidity: 74,
    soil_depth_bedrock_cm: null,
  };
}

test('buildSiteProfile: top-level keys', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.deepEqual(
    Object.keys(out).sort(),
    ['bioclim', 'climate', 'coverage', 'matched_cell', 'phenology', 'query', 'soil', 'zones']
  );
});

test('buildSiteProfile: query echoes input lat/lon', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.deepEqual(out.query, { lat: 36.65, lon: -121.80 });
});

test('buildSiteProfile: matched_cell carries lat, lon, elevation, distance, confidence', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.equal(out.matched_cell.lat, 36.75);
  assert.equal(out.matched_cell.lon, -121.75);
  assert.equal(out.matched_cell.elevation_m, 42);
  assert.ok(out.matched_cell.distance_km > 11 && out.matched_cell.distance_km < 13);
  assert.equal(out.matched_cell.coverage_confidence, 'exact');
});

test('buildSiteProfile: zones', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.deepEqual(out.zones, { koppen: 'Csb', hardiness: '9b' });
});

test('buildSiteProfile: climate block parses monthly arrays and renames fields', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.equal(out.climate.annual_mean_temp_c, 14.2);
  assert.equal(out.climate.annual_precip_mm, 412);
  assert.deepEqual(out.climate.monthly_temp_high_c, [18.1,19.0,19.8,20.5,21.2,22.0,22.5,22.6,22.0,20.8,19.2,18.0]);
  assert.deepEqual(out.climate.monthly_temp_low_c, [7.2,7.8,8.5,9.1,10.4,12.0,13.1,13.0,12.0,10.5,8.5,7.1]);
  assert.deepEqual(out.climate.monthly_precip_mm, [88,75,62,31,12,4,1,2,7,22,48,60]);
  assert.deepEqual(out.climate.monthly_humidity_pct, [72,71,70,69,68,70,73,74,73,72,72,73]);
  assert.equal(out.climate.mean_solar_radiation_mj_m2_day, 16.8);
  assert.equal(out.climate.mean_vapor_pressure_kpa, 1.12);
  assert.equal(out.climate.mean_relative_humidity_pct, 74);
});

test('buildSiteProfile: bioclim has all 19 BIO variables with correct unit suffixes', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.equal(out.bioclim.bio1_annual_mean_temp_c, 14.2);
  assert.equal(out.bioclim.bio2_mean_diurnal_range_c, 9.8);
  assert.equal(out.bioclim.bio3_isothermality, 52.1);
  assert.equal(out.bioclim.bio4_temp_seasonality, 412);
  assert.equal(out.bioclim.bio5_max_temp_warmest_c, 26.1);
  assert.equal(out.bioclim.bio6_min_temp_coldest_c, 3.9);
  assert.equal(out.bioclim.bio7_temp_annual_range_c, 22.2);
  assert.equal(out.bioclim.bio8_mean_temp_wettest_q_c, 9.8);
  assert.equal(out.bioclim.bio9_mean_temp_driest_q_c, 19.6);
  assert.equal(out.bioclim.bio10_mean_temp_warmest_q_c, 19.6);
  assert.equal(out.bioclim.bio11_mean_temp_coldest_q_c, 8.9);
  assert.equal(out.bioclim.bio12_annual_precip_mm, 412);
  assert.equal(out.bioclim.bio13_precip_wettest_month_mm, 88);
  assert.equal(out.bioclim.bio14_precip_driest_month_mm, 1);
  assert.equal(out.bioclim.bio15_precip_seasonality, 68);
  assert.equal(out.bioclim.bio16_precip_wettest_q_mm, 223);
  assert.equal(out.bioclim.bio17_precip_driest_q_mm, 4);
  assert.equal(out.bioclim.bio18_precip_warmest_q_mm, 7);
  assert.equal(out.bioclim.bio19_precip_coldest_q_mm, 211);
});

test('buildSiteProfile: phenology block', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.deepEqual(out.phenology, {
    frost_free_days: 298,
    growing_degree_days: 2480,
    first_frost_doy: 320,
    last_frost_doy: 38,
  });
});

test('buildSiteProfile: soil block has all 14 fields, bedrock null', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.equal(out.soil.ph_surface, 6.5);
  assert.equal(out.soil.clay_pct, 28.0);
  assert.equal(out.soil.silt_pct, 35.0);
  assert.equal(out.soil.sand_pct, 37.0);
  assert.equal(out.soil.organic_carbon_g_per_kg, 21.0);
  assert.equal(out.soil.cec_cmol_per_kg, 18.7);
  assert.equal(out.soil.nitrogen_g_per_kg, 1.8);
  assert.equal(out.soil.bulk_density_g_cm3, 1.32);
  assert.equal(out.soil.coarse_fragments_pct, 8.5);
  assert.equal(out.soil.water_field_capacity_pct, 28.2);
  assert.equal(out.soil.water_wilting_point_pct, 12.1);
  assert.equal(out.soil.available_water_pct, 16.1);
  assert.equal(out.soil.moisture_index, 0.42);
  assert.equal(out.soil.depth_bedrock_cm, null);
});

test('buildSiteProfile: coverage flags for fully populated row (bedrock false)', () => {
  const out = buildSiteProfile(fullRow(), 36.65, -121.80);
  assert.deepEqual(out.coverage, {
    climate: true,
    bioclim: true,
    phenology: true,
    soil: true,
    soil_depth_bedrock: false,
  });
});

test('buildSiteProfile: distance tier nearby (~30 km away)', () => {
  // Move query point ~30 km north of cell center.
  const out = buildSiteProfile(fullRow(), 37.02, -121.75);
  assert.equal(out.matched_cell.coverage_confidence, 'nearby');
  assert.ok(out.matched_cell.distance_km > 14 && out.matched_cell.distance_km <= 50);
});

test('buildSiteProfile: distance tier distant (~200 km away)', () => {
  const out = buildSiteProfile(fullRow(), 38.55, -121.75);
  assert.equal(out.matched_cell.coverage_confidence, 'distant');
  assert.ok(out.matched_cell.distance_km > 50);
});

function soilNullRow() {
  const row = fullRow();
  row.soil_ph_surface = null;
  row.soil_clay_pct = null;
  row.soil_sand_pct = null;
  row.soil_silt_pct = null;
  row.soil_organic_carbon = null;
  row.soil_cec = null;
  row.soil_nitrogen = null;
  row.soil_bulk_density = null;
  row.soil_coarse_fragments_pct = null;
  row.soil_water_field_capacity = null;
  row.soil_water_wilting_point = null;
  row.soil_available_water = null;
  row.soil_moisture_index = null;
  row.soil_depth_bedrock_cm = null;
  row.soil_texture_class = null;
  row.soil_nutriments_0_10 = null;
  return row;
}

test('buildSiteProfile: soil-NULL row → soil block all null', () => {
  const out = buildSiteProfile(soilNullRow(), 36.65, -121.80);
  for (const v of Object.values(out.soil)) {
    assert.equal(v, null);
  }
});

test('buildSiteProfile: soil-NULL row → coverage.soil false', () => {
  const out = buildSiteProfile(soilNullRow(), 36.65, -121.80);
  assert.equal(out.coverage.soil, false);
  assert.equal(out.coverage.soil_depth_bedrock, false);
});

test('buildSiteProfile: soil-NULL row → other groups unchanged', () => {
  const out = buildSiteProfile(soilNullRow(), 36.65, -121.80);
  assert.equal(out.coverage.climate, true);
  assert.equal(out.coverage.bioclim, true);
  assert.equal(out.coverage.phenology, true);
  assert.equal(out.climate.annual_mean_temp_c, 14.2);
  assert.equal(out.bioclim.bio1_annual_mean_temp_c, 14.2);
  assert.equal(out.phenology.frost_free_days, 298);
});
