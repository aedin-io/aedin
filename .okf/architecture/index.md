# Architecture

* [Repository structure](repository-structure.md) - the backend + web layout after the PolyCrop split.
* [Data flow](data-flow.md) - the layered ingestion → enrichment → normalization → scoring → serving pipeline.
* [DB split](db-split.md) - curated corpus (`aedin.sqlite`) vs raw GloBI (`globi.sqlite`), via `db-paths.cjs`.
* [Corpus vs live D1](corpus-and-live-d1.md) - the projected D1 mirror, drift, and publish hazards.
* [Classification system](classification-system.md) - role/bio-category paths and taxonomy-corruption hazards.
