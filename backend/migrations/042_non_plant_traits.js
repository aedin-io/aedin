'use strict';

/**
 * Migration 042: register non-plant entity traits in traits_vocabulary.
 *
 * Up through migration 041, the extractor's {{TRAITS_VOCABULARY}} template
 * only surfaced plant-oriented traits (pH, optimal_temp_min/max, optimal_
 * precip, optimal_light, optimal_soil_texture, growth_habit, nitrogen_
 * fixation, agronomic_uses). As a result, ingestion of entomology, plant-
 * pathology, soil-microbiology, and vertebrate ecology literature pulled
 * almost no entity_trait_claims — the LLM didn't know these were
 * extractable, even when the text explicitly described them.
 *
 * This migration adds non-plant trait names so the next ingestion pass
 * surfaces them. The entities table already has matching columns (added
 * across migrations 022-038 for the Phase-1 work).
 *
 * Idempotent: ON CONFLICT(trait_name) DO UPDATE.
 */

const TRAITS = [
  // ── Invertebrate biology ──────────────────────────────────────────
  {
    trait_name: 'voltinism',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: ['univoltine', 'bivoltine', 'multivoltine', 'semivoltine', 'facultative'],
    description: 'Number of generations completed per year. "Bivoltine" = 2 generations/year. Capture only when the source states it explicitly or directly implies it (e.g. "completes two generations per season").',
  },
  {
    trait_name: 'life_cycle_type',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: ['holometabolous', 'hemimetabolous', 'ametabolous', 'paurometabolous'],
    description: 'Insect development mode. Holometabolous = complete metamorphosis (egg → larva → pupa → adult, e.g. Lepidoptera, Coleoptera). Hemimetabolous = incomplete metamorphosis (egg → nymph → adult, e.g. Hemiptera).',
  },
  {
    trait_name: 'diet_breadth',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'vertebrate'],
    enum_values: ['monophagous', 'oligophagous', 'polyphagous', 'omnivorous'],
    description: 'Host or prey breadth. Monophagous = single host species. Oligophagous = few related host species or one host family. Polyphagous = many unrelated hosts. Omnivorous = both plant and animal matter.',
  },
  {
    trait_name: 'diet_type',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'vertebrate'],
    enum_values: ['herbivore', 'predator', 'parasitoid', 'parasite', 'omnivore', 'detritivore', 'fungivore', 'nectarivore', 'granivore'],
    description: 'What the organism eats. For arthropods, this often differs by life stage (e.g. Lycaenid butterflies: predaceous larva, nectarivorous adult); when so, prefer larval_role + adult_role traits.',
  },
  {
    trait_name: 'host_range',
    value_kind: 'list',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'fungi', 'microbe'],
    enum_values: null,
    description: 'Free-text description of known hosts (e.g. "all Solanaceae", "primarily Zea mays and other Poaceae"). Use specific taxa when given; capture the source\'s phrasing.',
  },
  {
    trait_name: 'thermal_min',
    value_kind: 'numeric',
    expected_unit: '°C',
    applicable_bio_categories: ['invertebrate', 'vertebrate'],
    enum_values: null,
    description: 'Lower thermal limit for activity or development. Distinct from optimal_temp_min (which is for plants). Capture as numeric °C.',
  },
  {
    trait_name: 'thermal_max',
    value_kind: 'numeric',
    expected_unit: '°C',
    applicable_bio_categories: ['invertebrate', 'vertebrate'],
    enum_values: null,
    description: 'Upper thermal limit for activity or development.',
  },
  {
    trait_name: 'thermal_kill_point',
    value_kind: 'numeric',
    expected_unit: '°C',
    applicable_bio_categories: ['invertebrate'],
    enum_values: null,
    description: 'Lethal temperature threshold (typically the cold-tolerance or heat-shock kill point). E.g. "supercooling point of -25 °C".',
  },
  {
    trait_name: 'degree_days_base10',
    value_kind: 'numeric',
    expected_unit: 'DD',
    applicable_bio_categories: ['invertebrate'],
    enum_values: null,
    description: 'Cumulative degree-days (base 10 °C) required for development from egg to adult, or for a specific life-stage transition. Capture only when the source specifies base 10.',
  },
  {
    trait_name: 'dispersal_range',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: null,
    description: 'Free-text dispersal capability description (e.g. "limited, <100 m/season", "long-distance windborne, >100 km").',
  },
  {
    trait_name: 'pest_mobility',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: ['sessile', 'limited', 'moderate', 'highly_mobile', 'migratory'],
    description: 'General mobility class for management-relevant decisions.',
  },
  {
    trait_name: 'crop_damage_type',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: ['defoliator', 'borer', 'sap_sucker', 'root_feeder', 'fruit_damager', 'leaf_miner', 'gall_former', 'seed_feeder', 'storage_pest'],
    description: 'Mode of crop damage. Sap-sucker examples: aphids, whiteflies. Borer examples: ECB (Ostrinia nubilalis), corn rootworm.',
  },
  {
    trait_name: 'vulnerable_host_stage',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: ['seedling', 'vegetative', 'flowering', 'fruiting', 'all_stages', 'post_harvest'],
    description: 'Crop life-stage at which this pest causes the most damage or attacks preferentially.',
  },
  {
    trait_name: 'commercial_biocontrol',
    value_kind: 'boolean',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'microbe', 'fungi'],
    enum_values: null,
    description: 'true if this organism is sold as a commercial biocontrol product (e.g. Trichogramma egg parasitoids, Bacillus thuringiensis). Cite a specific product/supplier when stated.',
  },
  {
    trait_name: 'known_natural_enemies',
    value_kind: 'list',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: null,
    description: 'Free-text list of known predators, parasitoids, or pathogens of this organism (e.g. "Trichogramma evanescens parasitizes eggs"). Each named enemy should ideally also become an interaction claim.',
  },
  {
    trait_name: 'activity_pattern',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'vertebrate'],
    enum_values: ['diurnal', 'nocturnal', 'crepuscular', 'cathemeral'],
    description: 'When the organism is active. Crepuscular = dawn/dusk. Cathemeral = irregular both day and night.',
  },
  {
    trait_name: 'migration_pattern',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'vertebrate'],
    enum_values: null,
    description: 'Free-text description of seasonal movement (e.g. "overwinters in southern range, migrates north each spring", "non-migratory").',
  },
  {
    trait_name: 'larval_role',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: ['herbivore', 'predator', 'parasitoid', 'detritivore', 'fungivore'],
    description: 'Ecological role at LARVAL stage. Often differs from adult — capture explicitly when the source distinguishes (e.g. "Chrysoperla carnea larva is a predator of aphids, but the adult feeds on nectar").',
  },
  {
    trait_name: 'adult_role',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate'],
    enum_values: ['herbivore', 'predator', 'parasitoid', 'pollinator', 'nectarivore', 'non_feeding', 'detritivore'],
    description: 'Ecological role at ADULT stage. Often differs from larva — capture explicitly when distinguished.',
  },

  // ── Pathogen biology (fungi, microbes, viruses, oomycetes) ────────
  {
    trait_name: 'disease_name',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'Common name of the disease this pathogen causes (e.g. "downy mildew", "Fusarium wilt", "bacterial spot"). Often differs from the pathogen organism name.',
  },
  {
    trait_name: 'pathogen_subtype',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'Forma specialis, race, pathovar, or strain designation when relevant (e.g. "Fusarium oxysporum f. sp. lycopersici race 3", "Xanthomonas campestris pv. campestris").',
  },
  {
    trait_name: 'transmission_mode',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: ['airborne', 'soilborne', 'seedborne', 'waterborne', 'vector_borne', 'contact', 'wound', 'pollen_borne'],
    description: 'Primary route of inoculum spread. Multiple modes possible (use most-cited).',
  },
  {
    trait_name: 'transmission_vector',
    value_kind: 'list',
    expected_unit: null,
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'Free-text vector identification when transmission is vector-borne (e.g. "Bemisia tabaci whitefly", "Frankliniella thrips"). Each named vector should ideally also become an interaction claim.',
  },
  {
    trait_name: 'survival_structure',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: ['sclerotia', 'chlamydospores', 'oospores', 'cysts', 'mycelium', 'spores', 'biofilm', 'endophyte'],
    description: 'Long-term survival propagule between host generations. Drives disease cycle modeling.',
  },
  {
    trait_name: 'soil_persistence_years',
    value_kind: 'numeric',
    expected_unit: 'years',
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'How many years inoculum can persist in soil without a host. E.g. Sclerotinia sclerotiorum sclerotia: 5–10 years. Used in crop-rotation interval design.',
  },
  {
    trait_name: 'leaf_wetness_hours',
    value_kind: 'numeric',
    expected_unit: 'h',
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'Minimum leaf-wetness duration required for infection at favorable temperature. E.g. "6 h continuous wetness above 15 °C". Used in disease-forecasting models.',
  },
  {
    trait_name: 'favorable_humidity',
    value_kind: 'categorical',
    expected_unit: '%',
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'Humidity range or threshold favoring infection (e.g. ">90% RH for 4+ hours"). Capture verbatim phrasing or numeric range.',
  },
  {
    trait_name: 'favorable_temp_min',
    value_kind: 'numeric',
    expected_unit: '°C',
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'Lower bound of temperature favorable for infection/sporulation.',
  },
  {
    trait_name: 'favorable_temp_max',
    value_kind: 'numeric',
    expected_unit: '°C',
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'Upper bound of temperature favorable for infection/sporulation.',
  },
  {
    trait_name: 'favorable_season',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: ['spring', 'summer', 'autumn', 'winter', 'wet_season', 'dry_season', 'year_round'],
    description: 'Season(s) when infection or disease pressure peaks.',
  },
  {
    trait_name: 'seed_borne',
    value_kind: 'boolean',
    expected_unit: null,
    applicable_bio_categories: ['fungi', 'microbe'],
    enum_values: null,
    description: 'true if the pathogen is transmitted on or in seed. Drives seed-treatment recommendations.',
  },
  {
    trait_name: 'frac_group',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['fungi'],
    enum_values: null,
    description: 'FRAC (Fungicide Resistance Action Committee) MoA group code for a fungicide active ingredient, OR documented resistance group(s) for a fungal pathogen (e.g. "FRAC 3 — DMI fungicides", "resistant to FRAC 11 QoIs"). Used in resistance-management planning.',
  },

  // ── Microbe / soil ────────────────────────────────────────────────
  {
    trait_name: 'soil_health_function',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['microbe', 'fungi'],
    enum_values: ['nitrogen_fixation', 'phosphorus_solubilization', 'mycorrhizal_association', 'organic_matter_decomposition', 'pathogen_suppression', 'aggregate_stability', 'siderophore_production', 'PGPR'],
    description: 'Soil-health-relevant functional role. PGPR = plant-growth-promoting rhizobacteria. Multi-functional organisms: pick the most-emphasized in the source.',
  },

  // ── Vertebrate ────────────────────────────────────────────────────
  {
    trait_name: 'conservation_status',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['vertebrate', 'invertebrate', 'plantae'],
    enum_values: ['LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX', 'DD', 'NE'],
    description: 'IUCN Red List status: Least Concern, Near Threatened, Vulnerable, Endangered, Critically Endangered, Extinct in the Wild, Extinct, Data Deficient, Not Evaluated.',
  },

  // ── General organism ──────────────────────────────────────────────
  {
    trait_name: 'habitat_type',
    value_kind: 'categorical',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'vertebrate', 'fungi', 'microbe'],
    enum_values: null,
    description: 'Free-text habitat description (e.g. "rice paddies", "tropical lowland forest", "rhizosphere of Solanaceae", "stored grain"). Prefer agronomic-relevant phrasing when the source provides it.',
  },
  {
    trait_name: 'native_regions',
    value_kind: 'list',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'vertebrate', 'fungi', 'microbe'],
    enum_values: null,
    description: 'Free-text or semicolon-separated list of native bioregions (e.g. "Mesoamerica; Andean South America"). For region promotion semantics see docs/promoted-localities.md.',
  },
  {
    trait_name: 'invasive_regions',
    value_kind: 'list',
    expected_unit: null,
    applicable_bio_categories: ['invertebrate', 'vertebrate', 'fungi', 'microbe'],
    enum_values: null,
    description: 'Free-text list of regions where the organism is recognized as invasive/introduced.',
  },
];

function migrate(db) {
  const stmt = db.prepare(`
    INSERT INTO traits_vocabulary
      (trait_name, value_kind, expected_unit, applicable_bio_categories, enum_values, description, introduced_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(trait_name) DO UPDATE SET
      value_kind = excluded.value_kind,
      expected_unit = excluded.expected_unit,
      applicable_bio_categories = excluded.applicable_bio_categories,
      enum_values = excluded.enum_values,
      description = excluded.description
  `);

  for (const t of TRAITS) {
    stmt.run(
      t.trait_name,
      t.value_kind,
      t.expected_unit,
      JSON.stringify(t.applicable_bio_categories),
      t.enum_values ? JSON.stringify(t.enum_values) : null,
      t.description
    );
  }

  console.log(`[migration-042] registered ${TRAITS.length} non-plant traits in traits_vocabulary`);
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
