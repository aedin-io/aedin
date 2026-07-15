---
type: Service
title: Public web site
description: The Astro static site serving entity/claim pages from a Cloudflare D1 mirror, deployed to Cloudflare Pages.
resource: https://aedin.io
tags: [service, web, astro, cloudflare, d1, pages]
timestamp: 2026-07-04T00:00:00Z
---

# Stack

`web/` is **Astro 5 + Tailwind 4 + better-sqlite3**, static output, deployed to **Cloudflare Pages** (project `agroeco`) backed by **D1** (`database_name=agroeco`).

# Pages

- `entity/[slug].astro` — SSR-from-D1 entity page; two-tab (Interactions | Traits) filterable/sortable/paginated table (`EntityClaimsTable.astro`), related entities, modification history (`RevisionHistory.astro`). Right-column sidebar: `EntityEnvelope.astro` ("Profile", from `entities.*` scalar columns) + `TraitSummary.astro` ("Trait summary", min–max range / union aggregated from the multi-source `entity_trait_claims` via `lib/trait-summary.ts` — see [/datasets/traits.md] keep-all-values policy).
- `globi/[id].astro` — SSR page for every served GloBI claim; literature ids 404 here and keep static `/claim/[id]`.
- Variety nav (shipped by the web chat): parent↔variety links, `/entity/[slug]/varieties`, inherited-trait badges.
- **Interaction-graph UX** — `/crop-web` offers an **X / quadrant layout**
  (`src/lib/x-layout.ts`, pure + vitest-tested): crop center, kingdom on the
  horizontal, valence on the vertical, biocontrol agents follow their target's
  side, on-demand ring-3 (supporters + disruptors). A shared selection panel
  (`src/lib/graph-panel.ts`) gives both `/crop-web` and `/atlas` persistent
  click-selection + clickable neighbor chips. Edge-driven, never `primary_role`.
- `index`, `about`, `data-sources`, `terms`, `404`.
- `simulator/` — an **embedded static app** (the **Agristory** polyculture pest-dynamics prototype, a *separate product* in its own repo): a self-contained Vite+Three.js bundle dropped at `web/public/simulator/` (built with `base=/simulator/`), served at `/simulator/`, linked from the header nav to the right of "API". As a `public/` static asset it bypasses the SSR middleware, so the [AI-access policy](/decisions/ai-access-policy.md) SSR guard does not cover it (robots.txt + edge WAF only). Powered read-only by an exported corpus slice (`sim_*` growth curves + cited `claims`); rates are designed, relationships cited.

# Build & deploy

```bash
cd web
npm run build      # static build + atlas data + Pagefind index + D1 data.sql
npm run deploy     # build, verify, deploy dist/ to Cloudflare Pages
```

The D1 data is built by `scripts/build-d1.cjs` from the corpus — see [corpus vs live D1](/architecture/corpus-and-live-d1.md) for the projection + publish hazards.

# Region vocabulary

A single pruned scope set (`backend/lib/region-vocab.json`) drives both the atlas and crop-web region pickers. The JSON (not a shared `.js`) is load-bearing because Vite bundles `.json` natively but won't CommonJS-transform a cross-root source `.js`.

# Related

- Serves [entities](/datasets/entities.md)/[claims](/datasets/claims.md)/[varieties](/datasets/varieties.md); governed by the [AI-access policy](/decisions/ai-access-policy.md).

# Citations

[1] `CLAUDE.md` §"Entity page + modification provenance"; §"Region vocabulary".
