export type Entity = {
  id: number;
  scientific_name: string;
  common_name: string | null;
  family: string | null;
  family_common_name?: string | null;
  genus: string | null;
  taxonomic_resolution?: string | null;
  taxonomy_path: string | null;
  bio_category: string | null;
  primary_role: string | null;
  crop_type?: string | null;
  slug: string | null;
  scope_tier?: number | null;
  variety_type?: string | null;
  parent_entity_id?: number | null;
  merged_into_entity_id?: number | null;
  grin_accession?: string | null;
  // Environmental envelope (Trefle-style for plants; thermal/humidity equivalents for animals)
  min_temp_c?: number | null;
  max_temp_c?: number | null;
  thermal_min?: number | null;
  thermal_max?: number | null;
  optimal_temp_min?: number | null;
  optimal_temp_max?: number | null;
  favorable_temp_min?: number | null;
  favorable_temp_max?: number | null;
  ph_min?: number | null;
  ph_max?: number | null;
  optimal_ph_min?: number | null;
  optimal_ph_max?: number | null;
  atmospheric_humidity?: number | null;
  favorable_humidity?: number | null;
  optimal_humidity_min?: number | null;
  optimal_humidity_max?: number | null;
  light_requirement?: number | null;
  soil_texture?: string | null;
  soil_humidity?: number | null;
  min_precipitation_mm?: number | null;
  max_precipitation_mm?: number | null;
  native_zones?: string | null;
  introduced_zones?: string | null;
  native_regions?: string | null;
  invasive_regions?: string | null;
  climate_zone?: string | null;
  growth_form?: string | null;
  growth_habit?: string | null;
  growth_rate?: string | null;
  average_height_cm?: number | null;
  maximum_height_cm?: number | null;
  spread_cm?: number | null;
  duration?: string | null;
  edible?: number | null;
  vegetable?: number | null;
  toxicity?: string | null;
  nitrogen_fixation?: number | null;
  growth_months?: string | null;
  bloom_months?: string | null;
  fruit_months?: string | null;
  activity_months?: string | null;
  life_cycle_type?: string | null;
  voltinism?: string | null;
  diet_breadth?: string | null;
  host_range?: string | null;

  // Linnaean ranks — populated for ~97% of non-plant entities
  kingdom?: string | null;
  phylum?: string | null;
  taxon_class?: string | null;
  taxon_order?: string | null;

  // External taxonomic identifiers — link out to authoritative databases
  gbif_key?: number | null;
  eppo_code?: string | null;
  iucn_id?: number | null;

  // Invertebrate biology
  larval_role?: string | null;
  adult_role?: string | null;
  commercial_biocontrol?: number | null;
  vulnerable_host_stage?: string | null;
  degree_days?: number | null;
  degree_days_base10?: number | null;
  thermal_kill_point?: number | null;
  known_natural_enemies?: string | null;
  dispersal_range?: string | null;
  migration_pattern?: string | null;
  activity_pattern?: string | null;
  pest_mobility?: string | null;

  // Pathogen biology
  disease_name?: string | null;
  transmission_mode?: string | null;
  transmission_vector?: string | null;
  pathogen_subtype?: string | null;
  frac_group?: string | null;
  survival_structure?: string | null;
  soil_persistence_years?: number | null;
  seed_borne?: number | null;
  leaf_wetness_hours?: number | null;
  favorable_season?: string | null;

  // Microbe / soil
  soil_health_function?: string | null;

  // Vertebrate / general organism
  conservation_status?: string | null;
  habitat_type?: string | null;
  diet_type?: string | null;
  organism_type?: string | null;
  crop_damage_type?: string | null;
};

export type Claim = {
  id: number;
  interaction_category: string | null;
  interaction_type_raw: string | null;
  interaction_type_globi: string | null;
  effect_direction: string | null;
  source_quote: string;
  source_page: string | null;
  reference_citation: string | null;
  subject_entity_id: number;
  object_entity_id: number | null;
  source_id: number | null;
  source_title: string | null;
  source_authors: string | null;
  source_year: number | null;
  source_publication: string | null;
  source_url: string | null;
  source_license: string | null;
  source_slug: string | null;
  subject_scientific_name: string | null;
  subject_common_name: string | null;
  subject_slug: string | null;
  object_scientific_name: string | null;
  object_common_name: string | null;
  object_slug: string | null;
  critic_verdicts: string | null;
};

export type EntityWithClaims = {
  entity: Entity;
  claims_by_category: Map<string, Claim[]>;
  total_claims: number;
};

export type RelatedEntity = {
  slug: string;
  scientific_name: string;
  common_name: string | null;
  bio_category: string | null;
  shared_count: number;
};

// A scoped GloBI claim carries chain_role + interaction_count + provenance on
// top of the literature Claim shape. interaction_type_globi is NULL on GloBI rows
// (the verb is in interaction_type_raw); critic_verdicts is always null.
export type GlobiClaim = Claim & {
  chain_role: string | null;
  interaction_count: number | null;
  reference_doi: string | null;
  reference_url: string | null;
  provenance: 'globi';
};

export type EntityGlobiClaims = {
  claims: GlobiClaim[];
  total: number; // total scoped GloBI claims for this entity (pre-cap), for "+N more"
};

// ── Crop-web GloBI layer ────────────────────────────────────────────────
// A bounded per-crop GloBI chain for the radial. `depth` is assigned by the
// chain hop that reached the node (1 = crop_interaction/attractant partner of
// the focus crop; 2 = biocontrol agent of a ring-1 node), NOT entities.scope_tier.
export type CropWebGlobiNode = {
  id: number;
  slug: string | null;
  scientific_name: string | null;
  common_name: string | null;
  bio_category: string | null;
  primary_role: string | null;
  depth: 1 | 2;
};

export type CropWebGlobiEdge = {
  id: number;
  subject_id: number;
  object_id: number;
  interaction_type_raw: string | null;
  interaction_category: string | null;
  chain_role: string | null;
  interaction_count: number | null;
  provenance: 'globi';
};

export type CropWebGlobi = {
  focus: string;                                  // focus crop slug
  nodes: CropWebGlobiNode[];                       // ring-1 + ring-2 (focus excluded)
  edges: CropWebGlobiEdge[];
  categories: { category: string; n: number }[];   // edge counts by interaction_category
  capped: { tier1_total: number; tier1_shown: number };
};

// ── Atlas GloBI greatest-hits slice ─────────────────────────────────────
export type AtlasGlobiNode = {
  id: number;
  slug: string | null;
  scientific_name: string | null;
  common_name: string | null;
  bio_category: string | null;
  primary_role: string | null;
  taxonomy_path: string | null;
  evidence: number;   // sum of incident slice-edge interaction_count
};

export type AtlasGlobiEdge = {
  id: number;
  subject_id: number;
  object_id: number;
  interaction_type_raw: string | null;
  interaction_category: string | null;
  chain_role: string | null;
  interaction_count: number | null;
  provenance: 'globi';
};

export type AtlasGlobiSlice = {
  edges: AtlasGlobiEdge[];
  nodes: AtlasGlobiNode[];
  categories: { category: string; n: number }[];
  total: number;   // pre-cap count of tier2_globi chain-role edges with an object
  cap: number;
};

export type CropGlobiCounts = {
  counts: { id: number; n: number }[];   // per-plant incident tier2_globi claim count
};
