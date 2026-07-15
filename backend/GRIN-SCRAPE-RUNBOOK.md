# GRIN full-scrape operational runbook (variety intake #4)

The gated GRIN pipeline (scrape → `grin_varieties` staging → `promote-grin-varieties.js`) is built + smoke-verified (tomato: 500 staged → 252 promoted, 76 landraces). This runbook is the **full ~2,460-crop-species scrape**, run as a separate operational step (network-bound, ~1.5–2 hrs).

## Steps

1. **Scrape all crop species into staging** (resumable):
   ```
   cd backend && node sync-grin-varieties.js
   ```
   - Scope: `primary_role='crop' AND parent_entity_id IS NULL` (~2,460 species).
   - `RATE_LIMIT_MS=2000` × ~2,460 ≈ 1.5–2 hrs wall-clock. Resumable: the per-species `grin_synced_at` marker means a re-run skips done species. `--force` re-syncs all; `--crop "<name>"` scopes to one.
   - Writes `grin_varieties` rows (idempotent on `grin_accession`).

2. **Promote the staged set** (gated, idempotent):
   ```
   cd backend && node promote-grin-varieties.js          # dry-run: un-promoted count
   node promote-grin-varieties.js --apply
   ```
   - Gates: improvement-level (Cultivar/Landrace/Cultivated→promote; Breeding/blank/Uncertain/Wild→skip-staged) + name-hygiene (rejects accession codes even when Cultivar-tagged) + accession-keyed dedup (exact sibling → enrich, not duplicate).
   - Idempotent: promoted rows are `promoted_at`-marked; re-apply is a no-op for them. Skipped rows stay staged (re-classifiable).

3. **Local build verify** (NO live publish):
   ```
   cd web && node scripts/build-d1.cjs
   ```
   - Confirms the served GRIN varieties (+ `landrace` variety_type) materialize. **The live D1 publish is sub-project #3** — do NOT `wrangler --remote` here.

## Cautions

- **Politeness:** GRIN-Global is a public USDA service. The 2 s delay + descriptive `User-Agent` are deliberate — do NOT parallelize or lower the delay.
- **Row cap:** `rows=2000` returned ~500 for tomato — GRIN appears to cap server-side at ~500. Mega-accession crops (wheat, maize, rice, soybean) may be **truncated**; complete coverage of those would need a pagination follow-on (not built).
- **Cross-chat / shared-DB coordination (IMPORTANT):** `backend/aedin.sqlite` is shared across all chat worktrees (symlinked into each from the primary checkout). The pre-#4 gate-less scraper's **888 ungated grin entities** (observed 2026-06-22) were **reconciled + removed 2026-06-23** — see "Gate-less reconciliation" below. Before any future full run, still confirm no other chat is scraping GRIN concurrently.

## State after the smoke run (2026-06-22)
- `grin_varieties`: 500 staged (tomato); 310 `promoted_at` (252 created + 58 enriched), 190 left staged (gated-skip, re-classifiable).
- `entities`: +252 served GRIN varieties (cultivar 176, landrace 76), all `grin_accession`, 0 `native_regions`.

## Gate-less reconciliation — DONE 2026-06-23 (branch `feat/variety-grin-reconcile`)

The 888 pre-#4 gate-less GRIN entities were reconciled via the new gated pipeline (`reconcile-grin-gateless.js` + a re-scrape). Spec/plans: `docs/superpowers/{specs/2026-06-22-variety-4-grin-gateless-reconciliation-design.md,plans/2026-06-22-variety-grin-reconcile-plan*}`.

- **Safety (verified vs live D1 first):** all 888 were `scope_tier=NULL` and **not on live D1** (live had 0 `variety_type=NULL` varieties); deleting them affected no served/live page.
- **Delete:** `reconcile-grin-gateless.js --apply` backed up all 888 → `backups/grin-gateless-reconcile-2026-06-23T02-24-02-575Z.json`, deleted them (736 okra + 127 *Abies* firs + 25 *Abelmoschus* CWR), and cleared `grin_synced_at` on the 2 okra crop parents (271, 215498). 888 `revision_log` rows (`method='reconcile-grin-gateless'`). Idempotent.
- **Re-scrape okra:** `Abelmoschus esculentus` 499 + `A. manihot` 238 = 737 staged. GRIN okra `improvement_level` is overwhelmingly un-improved: **Uncertain 485 · blank 246 · Cultivar 3 · Wild 2 · Cultivated 1 · Landrace 0**.
- **Gated promote → 3 clean okra cultivars** (`Clemson Spineless`, `UGA Red`, `PARBHANI KRANTI`; all `A. esculentus`, `scope_tier=0`, `variety_type=cultivar`, **0 `native_regions`**, 0 code-names). The widened name-hygiene gate (`/^[A-Z]{1,4}[\s-]?\d{2,}$/`) rejected 327 code-name accessions. This is the honest-traits outcome: 736 junk gate-less rows replaced by the 3 genuinely-named cultivars; the rest stay staged (re-classifiable).
- **Local build:** succeeds (38,634 served entities); the 3 okra cultivars materialize.
- **Fixture-validity:** okra is **cultivar-only (0 landrace)** — okra has ~0 Landrace-tagged GRIN accessions (the landrace tail, if any, is beyond the ~500 server cap → the pagination follow-on; not built). The corpus is **globally** fixture-valid (served varieties: cultivar 697 · landrace 76 · var 138 · subsp 124 · f 3), so the front-end has both branches to verify (landraces from the #4 tomato set).
- **No live publish.** The okra (and the corpus's 252 grin-tomato + 76 landraces) are served locally (`scope_tier=0`) but **not yet on live D1** — live D1 still serves a pre-#4 snapshot (777 varieties). Surfacing them is a **rebuild + republish** coordinated with the web chat (#3 pipeline).
