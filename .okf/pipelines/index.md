# Pipelines

* [GloBI ingestion](globi-ingestion.md) - raw CSV → indexed interactions → normalized claims.
* [LLM literature ingestion](llm-literature-ingestion.md) - subscription-only extract → vouch → multi-critic consensus → promote.
* [Variety intake](variety-intake.md) - cultivar/landrace model, kingdom-aware inheritance, gated GRIN pipeline + reconciliation.
* [GRIN-narrative enrichment](/pipelines/grin-narrative-enrichment.md) — scraped variety narratives → resistance (Phase 1) + trait (Phase 2) claims via the multi-critic → promote rails.
* [Companion scoring](scoring.md) - `crop_companion_scores` from claims + interaction-type rules.
* [Entity deduplication](entity-dedup.md) — tier duplicate taxa, merge the high-confidence tier reversibly.
