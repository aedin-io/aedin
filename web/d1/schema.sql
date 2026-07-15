-- D1 read-subset schema: only what SSR /entity/[slug] needs (Plan 2).
-- Loaded by build-d1.cjs -> wrangler d1 execute. SQLite-compatible DDL.
--
-- entities: TRIMMED to 92 cols (the Entity TS-type read-set in src/lib/queries.ts
-- + scope_tier). Cloudflare D1 caps tables at 100 columns, so the live 132-col
-- entities table cannot be mirrored whole. build-d1.cjs column-projects
-- (schema ∩ live source), so this file is the authority for which columns ship:
-- to surface another trait column on the edge, add it here (must exist in live)
-- and re-run the load. Constraints (NOT NULL / UNIQUE / AUTOINCREMENT) are
-- intentionally omitted — this is a read mirror loaded by explicit INSERTs, and a
-- UNIQUE on scientific_name would reject the known typo-duplicate rows.

DROP TABLE IF EXISTS entities;
CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  scientific_name TEXT,
  common_name TEXT,
  family TEXT,
  family_common_name TEXT,
  genus TEXT,
  taxonomy_path TEXT,
  bio_category TEXT,
  variety_type TEXT,
  primary_role TEXT,
  crop_type TEXT,
  climate_zone TEXT,
  duration TEXT,
  edible INTEGER,
  vegetable INTEGER,
  growth_rate TEXT,
  growth_habit TEXT,
  growth_form TEXT,
  average_height_cm REAL,
  maximum_height_cm REAL,
  spread_cm REAL,
  ph_min REAL,
  ph_max REAL,
  soil_texture INTEGER,
  soil_humidity INTEGER,
  light_requirement INTEGER,
  atmospheric_humidity INTEGER,
  min_temp_c REAL,
  max_temp_c REAL,
  min_precipitation_mm REAL,
  max_precipitation_mm REAL,
  nitrogen_fixation TEXT,
  toxicity TEXT,
  native_zones TEXT,
  introduced_zones TEXT,
  growth_months TEXT,
  bloom_months TEXT,
  fruit_months TEXT,
  organism_type TEXT,
  pest_mobility TEXT,
  host_range TEXT,
  native_regions TEXT,
  invasive_regions TEXT,
  activity_months TEXT,
  habitat_type TEXT,
  conservation_status TEXT,
  iucn_id INTEGER,
  gbif_key INTEGER,
  eppo_code TEXT,
  life_cycle_type TEXT,
  voltinism TEXT,
  diet_breadth TEXT,
  thermal_min REAL,
  thermal_max REAL,
  degree_days REAL,
  dispersal_range TEXT,
  commercial_biocontrol INTEGER,
  disease_name TEXT,
  transmission_mode TEXT,
  favorable_temp_min REAL,
  favorable_temp_max REAL,
  favorable_humidity TEXT,
  survival_structure TEXT,
  soil_persistence_years REAL,
  frac_group TEXT,
  transmission_vector TEXT,
  pathogen_subtype TEXT,
  seed_borne INTEGER,
  soil_health_function TEXT,
  diet_type TEXT,
  crop_damage_type TEXT,
  migration_pattern TEXT,
  activity_pattern TEXT,
  kingdom TEXT,
  phylum TEXT,
  taxon_class TEXT,
  taxon_order TEXT,
  optimal_temp_min REAL,
  optimal_temp_max REAL,
  optimal_humidity_min REAL,
  optimal_humidity_max REAL,
  optimal_ph_min REAL,
  optimal_ph_max REAL,
  vulnerable_host_stage TEXT,
  favorable_season TEXT,
  known_natural_enemies TEXT,
  leaf_wetness_hours REAL,
  thermal_kill_point REAL,
  larval_role TEXT,
  adult_role TEXT,
  slug TEXT,
  taxonomic_resolution TEXT,
  scope_tier INTEGER,
  parent_entity_id INTEGER,
  grin_accession TEXT,
  merged_into_entity_id INTEGER
);

CREATE INDEX idx_entities_slug ON entities(slug);

-- claims: literature (ai_reviewed) + scoped GloBI (tier2_globi with chain_role)
DROP TABLE IF EXISTS claims;
CREATE TABLE claims (
  id                     INTEGER PRIMARY KEY,
  subject_entity_id      INTEGER,
  object_entity_id       INTEGER,
  source_id              INTEGER,
  staging_id             INTEGER,
  data_tier              TEXT,
  review_status          TEXT,
  interaction_category   TEXT,
  interaction_type_raw   TEXT,
  interaction_type_globi TEXT,
  effect_direction       TEXT,
  chain_role             TEXT,
  source_quote           TEXT,
  source_page            TEXT,
  reference_citation     TEXT,
  reference_doi          TEXT,
  reference_url          TEXT,
  interaction_count      INTEGER,
  country                TEXT,
  subdivision            TEXT,
  regional_context       TEXT,
  resistance_level       TEXT
);
CREATE INDEX idx_claims_subject ON claims(subject_entity_id);
CREATE INDEX idx_claims_object  ON claims(object_entity_id);

-- claim_localities: per-claim country/subdivision provenance (GloBI region backfill)
DROP TABLE IF EXISTS claim_localities;
CREATE TABLE claim_localities (
  claim_id     INTEGER NOT NULL,
  country      TEXT NOT NULL,
  subdivision  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (claim_id, country, subdivision)
);
CREATE INDEX idx_cl_country ON claim_localities(country, subdivision);

-- sources: citations referenced by claims
DROP TABLE IF EXISTS sources;
CREATE TABLE sources (
  id          INTEGER PRIMARY KEY,
  slug        TEXT,
  title       TEXT,
  authors     TEXT,
  year        INTEGER,
  publication TEXT,
  url         TEXT,
  license     TEXT
);

-- claim_critic_verdicts: consensus badge data keyed by staging_id
DROP TABLE IF EXISTS claim_critic_verdicts;
CREATE TABLE claim_critic_verdicts (
  staging_id  INTEGER,
  critic_name TEXT,
  verdict     TEXT
);
CREATE INDEX idx_ccv_staging ON claim_critic_verdicts(staging_id);

-- entity_trait_claims: literature (ai_reviewed) trait records keyed by entity_id
-- (crop pH / days-to-harvest / host-range / toxicity / phenology ...). The
-- "trait half" of the corpus — published alongside interaction claims so the
-- edge serves both. Read-subset: serving-relevant columns only.
DROP TABLE IF EXISTS entity_trait_claims;
CREATE TABLE entity_trait_claims (
  id               INTEGER PRIMARY KEY,
  entity_id        INTEGER,
  trait_name       TEXT,
  value_numeric    REAL,
  value_text       TEXT,
  value_json       TEXT,
  unit             TEXT,
  source_id        INTEGER,
  staging_id       INTEGER,
  source_quote     TEXT,
  source_page      INTEGER,
  regional_context TEXT,
  review_status    TEXT,
  inherited_from_entity_id INTEGER
);
CREATE INDEX idx_etc_entity ON entity_trait_claims(entity_id);

-- entity_common_names: multilingual vernacular names per entity (GBIF + Wikidata
-- P1843), all languages, with provenance. Served subset only. Consumed (later, by
-- the web chat) for "also known as" + any-language search.
DROP TABLE IF EXISTS entity_common_names;
CREATE TABLE entity_common_names (
  entity_id    INTEGER,
  name         TEXT,
  language     TEXT,
  source       TEXT,
  source_ref   TEXT,
  is_preferred INTEGER
);
CREATE INDEX idx_ecn_entity ON entity_common_names(entity_id);
CREATE INDEX idx_ecn_name   ON entity_common_names(name COLLATE NOCASE);
CREATE INDEX idx_ecn_lang   ON entity_common_names(language);

-- revision_log: audit trail of programmatic modifications to entities/claims
-- (GBIF taxonomy re-resolution, bio_category reclassification, rank-floor
-- quarantine, …). Surfaced as a "Modification history" section so corrections
-- are transparent on the citable item page.
DROP TABLE IF EXISTS revision_log;
CREATE TABLE revision_log (
  id           INTEGER PRIMARY KEY,
  target_type  TEXT,
  target_id    INTEGER,
  field        TEXT,
  before_value TEXT,
  after_value  TEXT,
  changed_by   TEXT,
  method       TEXT,
  reason       TEXT,
  applied_at   TEXT,
  -- Denormalized for claim-target rows (build-d1-revisions-patch.cjs): the D1
  -- claims mirror omits removed/quarantined claims, so the entity-claim
  -- modification rollup reads these instead of JOINing to absent claims.
  subject_entity_id INTEGER,
  object_entity_id  INTEGER,
  subject_name TEXT,
  object_name  TEXT,
  served       INTEGER
);
CREATE INDEX idx_revlog_target ON revision_log(target_type, target_id);
CREATE INDEX idx_revlog_subject ON revision_log(subject_entity_id);
CREATE INDEX idx_revlog_object ON revision_log(object_entity_id);
