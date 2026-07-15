---
type: Architecture
title: Repository structure
description: The two-part layout of the AEDIN repo — the Node/Express backend and the Astro public web site — after the 2026-04-19 PolyCrop split.
tags: [architecture, layout, backend, web]
timestamp: 2026-06-23T00:00:00Z
---

# Layout

Since the **2026-04-19 repo split** (the consumer PWA was extracted to `/home/beef/projects/polycrop/`), this repo holds two parts:

```
aedin/
├── backend/                # Node.js/Express API server (CommonJS)
│   ├── server.js           # Main API server (port 3001)
│   ├── server-dev.js       # Dev variant (npm run dev)
│   ├── aedin.sqlite        # Curated AEDIN corpus  (see /architecture/db-split.md)
│   ├── globi.sqlite        # Raw GloBI source (~40GB)
│   ├── lib/db-paths.cjs    # CORPUS_DB / RAW_DB canonical paths
│   ├── sync-*.js           # External data sync (globi, trefle, gbif, wikidata, eppo, grin)
│   ├── load-globi-claims.js, build-scores.js, run-role-agent.js, classify-taxon.js
│   ├── lib/                # Shared logic (role-engine, region-vocab, gates, …)
│   ├── migrations/         # Sequential schema migrations
│   └── prompts/, .claude/agents/   # Role-agent + extractor/critic prompts-as-data
└── web/                    # Astro 5 + Tailwind 4 + better-sqlite3 public site
    ├── src/pages/          # entity/[slug], globi/[id], claim/[id], index, about, …
    ├── src/lib/db.ts, queries.ts   # Read-only SQLite + canonical serializers
    ├── scripts/build-d1.cjs        # Builds the D1 mirror from the corpus
    └── d1/schema.sql, astro.config.mjs
```

# Key facts

- The backend is **CommonJS**; the web app is ESM (Astro/Vite).
- The consumer PWA (network search, planner, my-garden) lives in **PolyCrop**, a separate repo consuming this backend over HTTP — there is no shared frontend code.
- **Infra identifiers retain the old `agroeco` name** (Cloudflare Pages project, D1 `database_name`, the GitHub repo) and must NOT be renamed or deploys break — despite the AEDIN brand rename. See [the brand-rename decision](/decisions/brand-rename-aedin.md).

# Related

- The [data flow](/architecture/data-flow.md) that runs across these files.
- The [DB split](/architecture/db-split.md) behind the two `.sqlite` files.
- The [backend API](/services/backend-api.md) and [web site](/services/web-site.md) services.

# Citations

[1] `CLAUDE.md` §"Repository Structure" and §"Repo split (2026-04-19)".
