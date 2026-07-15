// backend/sync-trefle-entities.js
'use strict';

require('dotenv').config();
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;
const TREFLE_TOKEN = process.env.TREFLE_TOKEN;
const TREFLE_BASE = 'https://trefle.io/api/v1';
const RATE_LIMIT_MS = 500;

if (!TREFLE_TOKEN) {
  console.error('TREFLE_TOKEN not set in .env — cannot sync.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let debugCount = 0;
async function fetchTrefle(scientificName) {
  const url = `${TREFLE_BASE}/plants/search?token=${TREFLE_TOKEN}&q=${encodeURIComponent(scientificName)}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (debugCount < 5) { debugCount++; console.warn(`  [debug] search ${res.status} for "${scientificName}": ${(await res.text()).slice(0, 200)}`); }
    return null;
  }
  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;

  const plantId = data.data[0].id;
  const detailUrl = `${TREFLE_BASE}/plants/${plantId}?token=${TREFLE_TOKEN}`;
  await sleep(RATE_LIMIT_MS);
  const detailRes = await fetch(detailUrl);
  if (!detailRes.ok) {
    if (debugCount < 5) { debugCount++; console.warn(`  [debug] detail ${detailRes.status} for "${scientificName}" (id=${plantId}): ${(await detailRes.text()).slice(0, 200)}`); }
    return null;
  }
  const detail = await detailRes.json();
  return { id: plantId, ...detail.data };
}

function mapTrefleToEntity(plant) {
  const g = plant.growth || {};
  const specs = plant.specifications || {};
  const main = plant.main_species || plant;
  const distributions = plant.distributions || {};

  return {
    family: plant.family?.name || null,
    family_common_name: plant.family_common_name || null,
    genus: plant.genus?.name || null,
    synonyms: plant.synonyms ? JSON.stringify(plant.synonyms.map(s => s.name)) : null,
    duration: main.duration ? JSON.stringify(main.duration) : null,
    edible: main.edible ? 1 : (main.edible === false ? 0 : null),
    vegetable: main.vegetable ? 1 : (main.vegetable === false ? 0 : null),
    edible_part: main.edible_part ? JSON.stringify(main.edible_part) : null,
    growth_rate: g.growth_rate || null,
    growth_habit: specs.growth_habit || null,
    growth_form: specs.growth_form || null,
    ligneous_type: specs.ligneous_type || null,
    shape_and_orientation: specs.shape_and_orientation || null,
    average_height_cm: specs.average_height ? specs.average_height.cm : null,
    maximum_height_cm: specs.maximum_height ? specs.maximum_height.cm : null,
    spread_cm: g.spread ? g.spread.cm : null,
    row_spacing_cm: g.row_spacing ? g.row_spacing.cm : null,
    min_root_depth_cm: g.minimum_root_depth ? g.minimum_root_depth.cm : null,
    ph_min: g.ph_minimum || null,
    ph_max: g.ph_maximum || null,
    optimal_ph_min: g.ph_minimum || null,
    optimal_ph_max: g.ph_maximum || null,
    soil_texture: g.soil_texture || null,
    optimal_soil_texture: g.soil_texture || null,
    soil_humidity: g.soil_humidity || null,
    optimal_soil_moisture: g.soil_humidity || null,
    soil_nutriments: g.soil_nutriments || null,
    soil_salinity: g.soil_salinity || null,
    light_requirement: g.light || null,
    optimal_light: g.light || null,
    atmospheric_humidity: g.atmospheric_humidity || null,
    optimal_humidity_min: g.atmospheric_humidity != null ? g.atmospheric_humidity * 10 : null,
    optimal_humidity_max: g.atmospheric_humidity != null ? g.atmospheric_humidity * 10 : null,
    days_to_harvest: g.days_to_harvest || null,
    min_temp_c: g.minimum_temperature ? g.minimum_temperature.deg_c : null,
    max_temp_c: g.maximum_temperature ? g.maximum_temperature.deg_c : null,
    optimal_temp_min: g.minimum_temperature ? g.minimum_temperature.deg_c : null,
    optimal_temp_max: g.maximum_temperature ? g.maximum_temperature.deg_c : null,
    min_precipitation_mm: g.minimum_precipitation ? g.minimum_precipitation.mm : null,
    max_precipitation_mm: g.maximum_precipitation ? g.maximum_precipitation.mm : null,
    optimal_precip_min: g.minimum_precipitation ? g.minimum_precipitation.mm : null,
    optimal_precip_max: g.maximum_precipitation ? g.maximum_precipitation.mm : null,
    nitrogen_fixation: g.nitrogen_fixation || null,
    toxicity: main.specifications?.toxicity || null,
    growth_months: g.growth_months ? JSON.stringify(g.growth_months) : null,
    bloom_months: g.bloom_months ? JSON.stringify(g.bloom_months) : null,
    fruit_months: g.fruit_months ? JSON.stringify(g.fruit_months) : null,
    native_zones: distributions.native ? JSON.stringify(distributions.native.map(d => d.name)) : null,
    introduced_zones: distributions.introduced ? JSON.stringify(distributions.introduced.map(d => d.name)) : null,
    image_url: plant.image_url || null,
  };
}

function calcCompleteness(entity) {
  const fullFields = [entity.ph_min, entity.ph_max, entity.min_root_depth_cm,
    entity.nitrogen_fixation, entity.growth_habit, entity.days_to_harvest,
    entity.min_temp_c, entity.max_temp_c];
  const count = fullFields.filter(f => f != null && f !== '').length;
  if (count >= 8) return 'full';
  if (count >= 3) return 'partial';
  return 'minimal';
}

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  const force = process.argv.includes('--force');
  const cropsOnly = process.argv.includes('--crops-only');
  const scopeClauses = ["bio_category = 'plantae'", "parent_entity_id IS NULL"];
  if (!force) scopeClauses.push('trefle_synced_at IS NULL');
  if (cropsOnly) scopeClauses.push("primary_role = 'crop'");
  const where = scopeClauses.join(' AND ');
  const plants = await db.all(`SELECT id, scientific_name, primary_role, crop_type, climate_zone FROM entities WHERE ${where}`);

  console.log(`Found ${plants.length} plant entities to sync with Trefle.`);

  let synced = 0;
  let notFound = 0;
  let reclassified = 0;
  let errors = 0;

  for (let i = 0; i < plants.length; i++) {
    const entity = plants[i];
    if (i > 0 && i % 100 === 0) {
      console.log(`  ... ${i}/${plants.length} (synced: ${synced}, not found: ${notFound}, errors: ${errors})`);
    }

    try {
      const plant = await fetchTrefle(entity.scientific_name);
      if (!plant) {
        notFound++;
        // Mark as synced so we don't retry on next run
        await db.run("UPDATE entities SET trefle_synced_at = datetime('now') WHERE id = ?", entity.id);
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      const mapped = mapTrefleToEntity(plant);

      const updates = {};
      for (const [k, v] of Object.entries(mapped)) {
        if (v !== null && v !== undefined) {
          if ((k === 'crop_type' && entity.crop_type) || (k === 'climate_zone' && entity.climate_zone)) continue;
          updates[k] = v;
        }
      }

      // Only set trefle_id if no other entity already claims it (UNIQUE constraint)
      const existing = await db.get('SELECT id FROM entities WHERE trefle_id = ? AND id != ?', [plant.id, entity.id]);
      if (!existing) {
        updates.trefle_id = plant.id;
      }
      updates.trefle_synced_at = new Date().toISOString();

      const keys = Object.keys(updates);
      if (keys.length === 0) { notFound++; continue; }

      const setClauses = keys.map(k => `${k} = ?`).join(', ') + ", updated_at = datetime('now')";
      const values = keys.map(k => updates[k]);

      await db.run(`UPDATE entities SET ${setClauses} WHERE id = ?`, [...values, entity.id]);

      const updated = await db.get('SELECT ph_min, ph_max, min_root_depth_cm, nitrogen_fixation, growth_habit, days_to_harvest, min_temp_c, max_temp_c FROM entities WHERE id = ?', entity.id);
      const completeness = calcCompleteness(updated);
      await db.run('UPDATE entities SET data_completeness = ? WHERE id = ?', [completeness, entity.id]);

      // Reclassify weeds that Trefle says are edible -> crop
      if (entity.primary_role === 'weed' && mapped.edible === 1) {
        await db.run("UPDATE entities SET primary_role = 'crop' WHERE id = ?", entity.id);
        reclassified++;
      }

      synced++;
    } catch (e) {
      console.warn(`  [error] ${entity.scientific_name}: ${e.message}`);
      errors++;
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log('\n=== Trefle Sync Summary ===');
  console.log(`Total plant entities: ${plants.length}`);
  console.log(`Synced:              ${synced}`);
  console.log(`Not found in Trefle: ${notFound}`);
  console.log(`Reclassified (weed->crop): ${reclassified}`);
  console.log(`Errors:              ${errors}`);

  const comp = await db.all("SELECT data_completeness, count(*) as c FROM entities WHERE bio_category = 'plantae' GROUP BY data_completeness");
  console.log('\nPlant completeness:');
  for (const r of comp) console.log(`  ${r.data_completeness}: ${r.c}`);

  await db.close();
  console.log('\nDone.');
}

main().catch(err => { console.error('Trefle sync failed:', err); process.exit(1); });
