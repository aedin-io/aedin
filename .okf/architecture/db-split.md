---
type: Architecture
title: DB split — corpus vs raw GloBI
description: The 2026-06-19 split of the on-disk store into the curated corpus (aedin.sqlite) and the raw GloBI source (globi.sqlite), resolved through one module.
tags: [architecture, database, sqlite, db-paths]
timestamp: 2026-06-23T00:00:00Z
---

# The two databases (split 2026-06-19)

| File | Role | Contents |
|---|---|---|
| `backend/aedin.sqlite` | **Curated AEDIN corpus** | `entities`, `claims`, trait claims, scores — the D1-build source |
| `backend/globi.sqlite` | **Raw GloBI source** (~40 GB) | raw `interactions` + locality-coverage tables only |

`globi.sqlite` **lacking `entities`/`claims` is expected, not a wipe** — those are curated-corpus tables.

# One canonical resolver

Both paths resolve through a single module, **`backend/lib/db-paths.cjs`**:

- `CORPUS_DB` → `aedin.sqlite`
- `RAW_DB` → `globi.sqlite`
- `ATTACH_RAW_SQL` — cross-DB scripts open `CORPUS_DB` and `ATTACH` the raw DB under the `raw.` alias.

This makes a future rename a one-file change, not a 150-file sweep. **Every curated reader** (the web `db.ts`, build scripts, freeze, `build-d1`) must point at `CORPUS_DB`.

# Worktree note

The `.sqlite` files are gitignored. In the per-chat git **worktrees**, `backend/aedin.sqlite` is a **symlink** to the one real corpus in the primary checkout — so all worktrees share a single physical corpus DB.

# Related

- [Repository structure](/architecture/repository-structure.md).
- [Corpus vs live D1](/architecture/corpus-and-live-d1.md) — the serving projection built from `CORPUS_DB`.

# Citations

[1] `CLAUDE.md` §"Brand: AEDIN" (DB filenames, 2026-06-19 corpus/raw split).
