---
type: Decision
title: Brand rename — AgroEco → AEDIN
description: The product was renamed AgroEco→AEDIN on 2026-06-16; forward-facing assets renamed, historical/engineering docs kept as-is, and infra identifiers deliberately NOT renamed.
tags: [decision, brand, rename, infra]
timestamp: 2026-06-23T00:00:00Z
---

# Decision (2026-06-16)

The product is now **AEDIN** (Agroecological Database of Interactions); canonical domain **aedin.io** (`agroeco.io` 301-redirects).

# What renamed vs what didn't

- **Renamed:** the live Astro site + forward-facing strategy/funder docs.
- **Kept as "AgroEco" (accurate past-tense record):** the journal, phase histories, `docs/superpowers/**`, and historical engineering docs.
- **Deliberately NOT renamed (or deploys break):** Cloudflare Pages project `agroeco`, D1 `database_name=agroeco`, `--project-name=agroeco`, and the GitHub repo (until a deliberate rename). See [repository structure](/architecture/repository-structure.md).
- **DB filenames** were chosen for a clean future rename: `aedin.sqlite` + `globi.sqlite`, resolved through one module (`lib/db-paths.cjs`) so a rename is a one-file change. See [the DB split](/architecture/db-split.md).

# Remaining cutover

DNS/email cutover, Zenodo DOI under AEDIN, GitHub repo rename, defensive `.ai`/`.net` registration — tracked in `docs/aedin-rename-sprint-plan.md`.

# Citations

[1] `CLAUDE.md` §"Brand: AEDIN (formerly AgroEco) — renamed 2026-06-16".
