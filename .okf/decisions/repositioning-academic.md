---
type: Decision
title: Repositioning — academic + bot-facing only
description: AEDIN is an agroecological data-extraction and citable knowledge-base tool for academic researchers and AI consumers; the consumer planner belongs to PolyCrop.
tags: [decision, positioning, scope, planner]
timestamp: 2026-06-23T00:00:00Z
---

# Decision (2026-04-30)

AEDIN's audience is **academic researchers and AI/bot consumers** — not end-user gardeners. The consumer-facing planner belongs to **PolyCrop** (a separate repo).

# Implications

- **Planner endpoints (`/api/planner/*`) are out of scope** — they move to PolyCrop's backend, are deleted, or kept as a thin compatibility layer until PolyCrop migrates. Bugs *inside* planner endpoints are no longer AEDIN's responsibility. See [the backend API](/services/backend-api.md).
- AEDIN's job is to expose **clean tags** (`entities.crop_type`/`edible`, [variety](/datasets/varieties.md) data, citable [claims](/datasets/claims.md)) so consumers can filter; the planner-side filtering is PolyCrop's concern.
- `tritrophic_chains`/`beneficial_chains` tables (empty) can be dropped — the raw [claims](/datasets/claims.md) graph is the sufficient academic primitive.
- [`companion_scores`](/pipelines/scoring.md) is kept as a derived data product, with no consumer serializer.
- Doc audience pivots from "ag-tech startups / IPM advisors" to "academic researchers / AI consumer applications / extension-research partnerships." This is a positioning change, not a scope reduction — the knowledge base is the same.

# Citations

[1] `CLAUDE.md` §"Repositioning (2026-04-30): AgroEco is academic + bot-facing only".
