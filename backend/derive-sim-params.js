'use strict';
/**
 * derive-sim-params.js — regenerate the sim-params layer from corpus facts +
 * designed defaults. Reads entities / entity_trait_claims / claims; writes ONLY
 * sim_* tables (one-directional — never mutates the corpus). It also appends
 * one run-summary row per table to `revision_log` (target_type='sim_layer') as
 * the regeneration audit trail; it never writes entity/claim/trait corpus data.
 * Full-replace of derived/designed rows, override rows preserved. Dry-run by
 * default; --apply to write; --run-id=<tag> to label the run.
 */
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { logRevisions } = require('./lib/revision-log');
const S = require('./lib/sim-derive');
const ES = require('./lib/sim-ecosystem-service');

const TRAIT_TO_FACT = {
  maximum_height_cm: 'max_height_cm', average_height_cm: 'max_height_cm',
  in_row_spacing_cm: 'max_spread_cm', days_to_harvest: 'days_to_harvest',
  root_architecture: 'root_architecture', growth_habit: 'growth_habit',
  life_cycle: 'life_cycle', growth_determinacy: 'growth_determinacy',
  produce_color: 'produce_color', voltinism: 'voltinism',
  generations_per_year: 'generations_per_year', favorable_season: 'favorable_season',
  activity_months: 'activity_months', survival_structure: 'survival_structure',
};
const NUMERIC_FACTS = new Set(['max_height_cm', 'max_spread_cm', 'days_to_harvest', 'generations_per_year']);

function gatherFacts(db, ids) {
  const facts = new Map();
  if (!ids.length) return facts;
  const place = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT entity_id, trait_name, value_numeric, value_text FROM entity_trait_claims
     WHERE review_status='ai_reviewed' AND entity_id IN (${place})
       AND trait_name IN (${Object.keys(TRAIT_TO_FACT).map(() => '?').join(',')})`
  ).all(...ids, ...Object.keys(TRAIT_TO_FACT));
  for (const r of rows) {
    const key = TRAIT_TO_FACT[r.trait_name];
    const f = facts.get(r.entity_id) || {};
    if (f[key] == null) f[key] = NUMERIC_FACTS.has(key) ? r.value_numeric : r.value_text;
    facts.set(r.entity_id, f);
  }
  return facts;
}

function plantPopulation(db) {
  return db.prepare(`
    SELECT e.id, e.crop_type, e.edible, e.growth_habit, e.maximum_height_cm, e.spread_cm, e.min_root_depth_cm,
           e.nitrogen_fixation, e.cn_ratio, e.growth_rate, e.fertility_requirement, e.soil_nutriments, e.life_cycle_type AS life_cycle
    FROM entities e
    WHERE e.scope_tier IS NOT NULL AND e.bio_category='plantae'
      AND ( e.crop_type IS NOT NULL OR e.edible=1
            OR e.id IN (SELECT entity_id FROM entity_trait_claims
                        WHERE review_status='ai_reviewed'
                          AND trait_name IN ('maximum_height_cm','average_height_cm','in_row_spacing_cm',
                              'between_row_spacing_cm','days_to_harvest','growth_habit','life_cycle','root_architecture')) )
  `).all();
}

function deriveAll(db) {
  // --- plants: growth + visual ---
  const plants = plantPopulation(db);
  const facts = gatherFacts(db, plants.map((p) => p.id));
  const growth = [], visual = [];
  for (const p of plants) {
    const f = Object.assign({}, facts.get(p.id) || {});
    if (f.max_height_cm == null && p.maximum_height_cm != null) f.max_height_cm = p.maximum_height_cm; // entities fallback
    if (f.max_spread_cm == null && p.spread_cm != null) f.max_spread_cm = p.spread_cm;
    if (f.min_root_depth_cm == null && p.min_root_depth_cm != null) f.min_root_depth_cm = p.min_root_depth_cm;
    if (f.growth_habit == null && p.growth_habit) f.growth_habit = p.growth_habit;
    const info = S.classifyLifeForm(f.growth_habit, f.life_cycle, null);
    const g = S.growthCurveParams(f, info); g.entity_id = p.id; growth.push(g);
    const v = S.visualMapping(g, f); v.entity_id = p.id; visual.push(v);
  }
  // --- ecosystem services (Bucket B): per-plant categorical indicators from entities facts ---
  const ecosystem = plants.map((p) => {
    const f = Object.assign({}, facts.get(p.id) || {});
    if (f.growth_habit == null && p.growth_habit) f.growth_habit = p.growth_habit;
    const es = ES.ecosystemServiceParams({
      nitrogen_fixation: p.nitrogen_fixation, cn_ratio: p.cn_ratio, growth_rate: p.growth_rate,
      fertility_requirement: p.fertility_requirement, soil_nutriments: p.soil_nutriments,
      min_root_depth_cm: p.min_root_depth_cm != null ? p.min_root_depth_cm : f.min_root_depth_cm,
      growth_habit: f.growth_habit, life_cycle: p.life_cycle,
      maximum_height_cm: p.maximum_height_cm, spread_cm: p.spread_cm,
    });
    es.entity_id = p.id; return es;
  });
  // --- pests: subjects of ai_reviewed pest_pressure / herbivory ---
  const pestIds = db.prepare(
    `SELECT DISTINCT subject_entity_id AS id FROM claims
     WHERE review_status='ai_reviewed' AND interaction_category IN ('pest_pressure','herbivory')
       AND subject_entity_id IS NOT NULL`).all().map((r) => r.id);
  const pestFacts = gatherFacts(db, pestIds);
  const pest = pestIds.map((id) => {
    const r = S.pestDynamics(pestFacts.get(id) || {}); r.entity_id = id; return r;
  });
  // --- biocontrol: ai_reviewed biocontrol edges ---
  const edges = db.prepare(`
    SELECT c.id AS claim_id, c.subject_entity_id AS enemy, c.object_entity_id AS pest,
           es.primary_role AS enemy_primary_role, es.diet_breadth AS enemy_diet_breadth,
           es.commercial_biocontrol AS commercial_biocontrol
    FROM claims c LEFT JOIN entities es ON es.id = c.subject_entity_id
    WHERE c.review_status='ai_reviewed' AND c.interaction_category='biocontrol'`).all();
  const biocontrol = edges.map((e) => {
    const r = S.biocontrolDefaults(e);
    r.claim_id = e.claim_id; r.enemy_entity_id = e.enemy; r.pest_entity_id = e.pest; return r;
  });
  return { growth, visual, pest, biocontrol, ecosystem };
}

const COLS = {
  sim_plant_growth: ['entity_id','life_form','time_unit','max_height_cm','max_spread_cm','max_root_depth_cm','min_root_depth_cm','root_pattern','days_to_maturity','height_curve_model','height_inflection','height_rate_k','spread_curve_model','spread_inflection','spread_rate_k','canopy_layer','seasonality','light_extinction_coeff','param_status','derivation_method','model_ref','inputs_json','confidence','generated_run_id'],
  sim_visual: ['entity_id','model_archetype','canopy_shape','foliage_color','produce_color','height_scale_cm','spread_scale_cm','param_status','derivation_method','model_ref','inputs_json','confidence','generated_run_id'],
  sim_pest_dynamics: ['entity_id','generations_per_year','onset_season','onset_months','pressure_buildup_rate','peak_pressure','overwintering','param_status','derivation_method','model_ref','inputs_json','confidence','generated_run_id'],
  sim_biocontrol: ['claim_id','enemy_entity_id','pest_entity_id','control_magnitude','response_lag_days','establishment','specificity','param_status','derivation_method','model_ref','inputs_json','confidence','generated_run_id'],
  sim_ecosystem_service: ['entity_id','nitrogen_fixation_class','residue_decomposition','nutrient_demand','rooting_niche','growth_strategy','ground_cover','life_cycle_class','biomass_contribution','soil_functions','param_status','derivation_method','model_ref','inputs_json','confidence','generated_run_id'],
};
const KEY = { sim_plant_growth: 'entity_id', sim_visual: 'entity_id', sim_pest_dynamics: 'entity_id', sim_biocontrol: 'claim_id', sim_ecosystem_service: 'entity_id' };

function writeTable(db, table, rows, runId) {
  const key = KEY[table];
  const overridden = new Set(db.prepare(`SELECT ${key} k FROM ${table} WHERE param_status='override'`).all().map((r) => r.k));
  db.prepare(`DELETE FROM ${table} WHERE param_status IN ('derived','designed')`).run();
  const cols = COLS[table];
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  let n = 0;
  for (const row of rows) {
    if (overridden.has(row[key])) continue; // preserve human override
    row.generated_run_id = runId;
    stmt.run(cols.map((c) => (row[c] === undefined ? null : row[c])));
    n++;
  }
  return n;
}

function applyDerivation(db, derived, { runId }) {
  const summary = {};
  const tx = db.transaction(() => {
    for (const table of Object.keys(COLS)) {
      const rows = table === 'sim_visual' ? derived.visual
        : table === 'sim_pest_dynamics' ? derived.pest
          : table === 'sim_biocontrol' ? derived.biocontrol
            : table === 'sim_ecosystem_service' ? derived.ecosystem : derived.growth;
      const before = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
      summary[table] = writeTable(db, table, rows, runId);
      const after = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
      logRevisions(db, {
        targetType: 'sim_layer', targetId: 0, changedBy: 'derive-sim-params.js',
        method: `derive_sim_params:${runId}`, reason: table,
        changes: [{ field: table, before, after }],
      });
    }
  });
  tx();
  return summary;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const runArg = args.find((a) => a.startsWith('--run-id='));
  const runId = runArg ? runArg.split('=')[1] : `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const db = new Database(CORPUS_DB, { readonly: !apply });
  const derived = deriveAll(db);
  const counts = { growth: derived.growth.length, visual: derived.visual.length, pest: derived.pest.length, biocontrol: derived.biocontrol.length, ecosystem: derived.ecosystem.length };
  if (!apply) {
    console.log('[derive-sim-params] DRY RUN — would write:', counts, '(pass --apply to write)');
    db.close(); return;
  }
  const summary = applyDerivation(db, derived, { runId });
  console.log(`[derive-sim-params] run ${runId} wrote`, summary);
  db.close();
}

module.exports = { deriveAll, applyDerivation, gatherFacts, plantPopulation };
if (require.main === module) main();
