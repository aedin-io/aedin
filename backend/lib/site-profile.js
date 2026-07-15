'use strict';

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function coverageConfidence(distanceKm) {
  if (distanceKm <= 14) return 'exact';
  if (distanceKm <= 50) return 'nearby';
  return 'distant';
}

function parseLatLon(latRaw, lonRaw) {
  if (latRaw === undefined || latRaw === null || latRaw === '') {
    return { ok: false, error: 'lat query parameter required' };
  }
  if (lonRaw === undefined || lonRaw === null || lonRaw === '') {
    return { ok: false, error: 'lon query parameter required' };
  }
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat)) {
    return { ok: false, error: 'lat must be a finite number' };
  }
  if (!Number.isFinite(lon)) {
    return { ok: false, error: 'lon must be a finite number' };
  }
  if (lat < -90 || lat > 90) {
    return { ok: false, error: 'lat must be in [-90, 90]' };
  }
  if (lon < -180 || lon > 180) {
    return { ok: false, error: 'lon must be in [-180, 180]' };
  }
  return { ok: true, lat, lon };
}

function parseJsonArray(text) {
  if (text === null || text === undefined) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildSiteProfile(row, queryLat, queryLon) {
  const distance_km = haversineKm(queryLat, queryLon, row.lat, row.lon);
  const distance_km_rounded = Math.round(distance_km * 10) / 10;

  const climate = {
    annual_mean_temp_c: row.bio1_annual_mean_temp,
    annual_precip_mm: row.bio12_annual_precip,
    monthly_temp_high_c: parseJsonArray(row.monthly_temp_high),
    monthly_temp_low_c: parseJsonArray(row.monthly_temp_low),
    monthly_precip_mm: parseJsonArray(row.monthly_precip_mm),
    monthly_humidity_pct: parseJsonArray(row.monthly_humidity),
    mean_solar_radiation_mj_m2_day: row.mean_solar_radiation,
    mean_vapor_pressure_kpa: row.mean_vapor_pressure,
    mean_relative_humidity_pct: row.mean_relative_humidity,
  };

  const bioclim = {
    bio1_annual_mean_temp_c: row.bio1_annual_mean_temp,
    bio2_mean_diurnal_range_c: row.bio2_mean_diurnal_range,
    bio3_isothermality: row.bio3_isothermality,
    bio4_temp_seasonality: row.bio4_temp_seasonality,
    bio5_max_temp_warmest_c: row.bio5_max_temp_warmest,
    bio6_min_temp_coldest_c: row.bio6_min_temp_coldest,
    bio7_temp_annual_range_c: row.bio7_temp_annual_range,
    bio8_mean_temp_wettest_q_c: row.bio8_mean_temp_wettest_q,
    bio9_mean_temp_driest_q_c: row.bio9_mean_temp_driest_q,
    bio10_mean_temp_warmest_q_c: row.bio10_mean_temp_warmest_q,
    bio11_mean_temp_coldest_q_c: row.bio11_mean_temp_coldest_q,
    bio12_annual_precip_mm: row.bio12_annual_precip,
    bio13_precip_wettest_month_mm: row.bio13_precip_wettest_month,
    bio14_precip_driest_month_mm: row.bio14_precip_driest_month,
    bio15_precip_seasonality: row.bio15_precip_seasonality,
    bio16_precip_wettest_q_mm: row.bio16_precip_wettest_q,
    bio17_precip_driest_q_mm: row.bio17_precip_driest_q,
    bio18_precip_warmest_q_mm: row.bio18_precip_warmest_q,
    bio19_precip_coldest_q_mm: row.bio19_precip_coldest_q,
  };

  const phenology = {
    frost_free_days: row.frost_free_days,
    growing_degree_days: row.growing_degree_days,
    first_frost_doy: row.first_frost_doy,
    last_frost_doy: row.last_frost_doy,
  };

  const soil = {
    ph_surface: row.soil_ph_surface,
    clay_pct: row.soil_clay_pct,
    silt_pct: row.soil_silt_pct,
    sand_pct: row.soil_sand_pct,
    organic_carbon_g_per_kg: row.soil_organic_carbon,
    cec_cmol_per_kg: row.soil_cec,
    nitrogen_g_per_kg: row.soil_nitrogen,
    bulk_density_g_cm3: row.soil_bulk_density,
    coarse_fragments_pct: row.soil_coarse_fragments_pct,
    water_field_capacity_pct: row.soil_water_field_capacity,
    water_wilting_point_pct: row.soil_water_wilting_point,
    available_water_pct: row.soil_available_water,
    moisture_index: row.soil_moisture_index,
    depth_bedrock_cm: row.soil_depth_bedrock_cm,
    texture_class: row.soil_texture_class,
    nutriments_0_10: row.soil_nutriments_0_10,
  };

  const coverage = {
    climate: row.bio1_annual_mean_temp != null && row.monthly_temp_high != null,
    bioclim: row.bio1_annual_mean_temp != null,
    phenology: row.frost_free_days != null,
    soil: row.soil_ph_surface != null,
    soil_depth_bedrock: row.soil_depth_bedrock_cm != null,
  };

  return {
    query: { lat: queryLat, lon: queryLon },
    matched_cell: {
      lat: row.lat,
      lon: row.lon,
      distance_km: distance_km_rounded,
      coverage_confidence: coverageConfidence(distance_km_rounded),
      elevation_m: row.elevation_m,
    },
    zones: {
      koppen: row.koppen_zone,
      hardiness: row.hardiness_zone,
    },
    climate,
    bioclim,
    phenology,
    soil,
    coverage,
  };
}

module.exports = { haversineKm, coverageConfidence, parseLatLon, buildSiteProfile };
