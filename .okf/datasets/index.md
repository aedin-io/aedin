# Datasets

* [entities](entities.md) - the central taxon/organism table; source of truth for roles, taxonomy, and serving status.
* [claims](claims.md) - normalized interaction/trait assertions, tiered by evidence source.
* [varieties](varieties.md) - cultivar/landrace/infraspecies entities and their served inventory.
* [traits](traits.md) - traits_vocabulary controlled vocabulary + entity_trait_claims typed values; value_kind storage model.
* [sim-params](sim-params.md) - four typed tables (`sim_plant_growth`, `sim_pest_dynamics`, `sim_biocontrol`, `sim_visual`) with derived/designed model parameters for polyculture/agroforestry simulators; one-directionally regenerated from the corpus via `derive-sim-params.js`, corpus-local and not served to D1.
