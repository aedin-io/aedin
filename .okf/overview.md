---
type: Project Overview
title: AEDIN — Agroecological Database of Interactions
description: An agroecological discovery engine and citable knowledge base built on the GloBI dataset, targeting academic researchers and AI/bot consumers.
tags: [aedin, overview, agroecology, knowledge-base]
timestamp: 2026-06-23T00:00:00Z
---

# What AEDIN is

**AEDIN** (**A**gro**E**cological **D**atabase of **I**nteractions; formerly *AgroEco*, renamed 2026-06-16) is an ecological discovery engine and **citable knowledge base** built on top of the [Global Biotic Interactions (GloBI)](https://www.globalbioticinteractions.org/) dataset. It surfaces species relationships — pest, pathogen, beneficial, pollinator, biocontrol — enriched with curated literature claims, environmental traits, and crop/variety data.

Canonical domain: **aedin.io** (registered 2026-06-16; `agroeco.io` 301-redirects).

# Audience & positioning

AEDIN is an **academic + bot-facing** data-extraction and knowledge-base tool. Its consumers are **academic researchers** and **AI/bot consumers**, not end-user gardeners — the consumer-facing planner was extracted to the separate **PolyCrop** repo (`/home/beef/projects/polycrop/`) on 2026-04-19. See [the repositioning decision](/decisions/repositioning-academic.md).

# How it fits together

- A **Node.js/Express backend** (`backend/`) ingests, normalizes, scores, and serves the data over REST. See [backend API](/services/backend-api.md).
- A static **Astro web site** (`web/`) serves entity/claim pages from a Cloudflare **D1** mirror of the curated corpus. See [the web site](/services/web-site.md).
- Data moves through a [layered pipeline](/architecture/data-flow.md): raw GloBI ingestion → external enrichment → claim normalization → scoring → serving, plus a subscription-only [LLM literature-ingestion pipeline](/pipelines/llm-literature-ingestion.md).
- The on-disk store is [split into two SQLite DBs](/architecture/db-split.md): the curated **corpus** (`aedin.sqlite`) and the raw **GloBI source** (`globi.sqlite`).

# Map of this bundle

- [Architecture](/architecture/index.md) — repository structure, data flow, the DB split, the corpus↔live-D1 serving model, and classification.
- [Pipelines](/pipelines/index.md) — GloBI ingestion, LLM literature ingestion, variety intake, and scoring.
- [Datasets](/datasets/index.md) — the `entities`, `claims`, and variety data models.
- [Services](/services/index.md) — the backend API and the public web site.
- [Decisions](/decisions/index.md) — durable strategic/architectural decisions.

# Citations

[1] `CLAUDE.md` — the canonical project-instructions file, root of the repository.
[2] [GloBI](https://www.globalbioticinteractions.org/) — the source interaction dataset.
