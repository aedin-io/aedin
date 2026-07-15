---
type: Service
title: Backend API
description: The Node.js/Express REST server exposing discovery, planner (deprecated), and admin/pipeline endpoints over the curated corpus.
resource: http://localhost:3001
tags: [service, backend, express, api]
timestamp: 2026-06-23T00:00:00Z
---

# Server

`backend/server.js` (port 3001; `server-dev.js` via `npm run dev`) reads from the [corpus](/architecture/db-split.md) and serves REST.

# Endpoint groups

**Explorer / discovery:**
- `GET /api/status`, `/api/crops`, `/api/varieties/:cropName`, `/api/search`, `/api/categories`
- `GET /api/crops/:cropId/interactions` — pests/pathogens/beneficials for a crop
- `GET /api/neighborhood/:id` — 3-degree BFS neighborhood (capped at 500 nodes)
- `GET /api/site/profile?lat&lon` — themed environmental profile for the nearest `climate_grid` cell, with distance-tiered `coverage_confidence`

**Planner (`/api/planner/*`)** — **out of scope / deprecated.** Recommendations, companions, crop-ecology, polyculture, tritrophic. These belong to PolyCrop; see [the repositioning decision](/decisions/repositioning-academic.md).

**Admin / pipeline:**
- `GET /admin`; `GET|POST /api/admin/{regions,queue*,staging*,pending-crops*,autocomplete/biota}`

# Notes

- `POST /api/ingest-bbox` is **not implemented** — do not rely on it; bbox filtering is query-time via `regions.json`.
- Indexes exist on `source_name`, `target_name`, `lat/lng`, `location`, `interaction_type`.

# Related

- Reads [entities](/datasets/entities.md) + [claims](/datasets/claims.md); the AI-access policy [restricts what bots may hit](/decisions/ai-access-policy.md).

# Citations

[1] `CLAUDE.md` §"Key backend endpoints".
