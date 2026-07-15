---
type: Pipeline
title: Entity deduplication
description: Detect duplicate taxon rows, tier candidates by confidence, and merge the high-confidence tier through a reversible rail.
tags: [pipeline, dedup, entities, taxonomy, reversibility]
timestamp: 2026-07-03T00:00:00Z
---

# Why it matters

The corpus accretes duplicate taxon rows — scientific-name typos, `×`-hybrid name variants, junk-character extraction artifacts, and cultivar-collision pairs. Duplicates split an organism's evidence across two nodes and (when one lacks a [slug](/datasets/entities.md)) leave it unservable.

# The rail (committed, shared)

- `entity_dedup_candidates` (migration 045) — candidate pairs with a `status` (pending→approved→rejected→merged) and a `tier` (064).
- `sweep-entity-dedup.js::sweepDedup` — genus-blocked epithet-Levenshtein≤2 detector. Blind to `×`-marker / junk-char / cultivar collisions (the epithet token is `×`, or the genus token differs).
- `merge-entity.js::mergeCandidate` — re-points `claims` + `entity_trait_claims` + child `parent_entity_id` FKs loser→canonical, tombstones the loser (`entities.merged_into_entity_id`), and records the exact redirected ids in **`entity_dedup_log`** (065) so **`unmergeEntity`** is faithful. Read paths filter `merged_into_entity_id IS NULL`.

# Precision tiering (this subsystem)

- `lib/dedup-tier.js` (pure) — `tierOf` classifies a pair into `auto_safe` | `needs_review` | `domain`; a **token-count guard runs first** so a binomial typo never absorbs a trinomial subspecies. Three **unreliable-epithet guards** (added after the first operational drain) demote to `needs_review` the classes where the sweep's 2nd-token distance is bogus: a hybrid marker is present (`Quercus × eplingii` vs `Quercus X megaleia`), a placeholder/morphospecies code (`sp1`/`sp12`, `sp.A`/`sp.B`, `Unidentified…`), or a genus mismatch beyond a 1-edit typo (cross-genus pair the sweep mis-paired via the stored genus column). `pickCanonicalForDedup` picks the canonical by gbif-anchor → data-mass → served → lower-id.
- `build-slug-collision-candidates.js` — ingests the slug-backfill's `needs_dedup` pairs (`match_basis='slug_collision'`) the sweep can't see, pairing orphan singletons to their slugged twin by base slug.
- `tier-candidates.js` — backfills `tier` + refreshes `suggested_canonical_id` over every candidate.
- `drain-auto-safe.js` — emits review artifacts (all `domain`/`×`-marker pairs for full agroecologist+horticulturist review; a stratified `auto_safe` sample for spot-check), then under `--apply` backs up loser rows and merges the `auto_safe` tier. `needs_review` + `domain` stay bucketed for the follow-on review surface.

# Review surface (follow-on #2)

Triages the `pending` `entity_dedup_candidates` an agent-batch reviewer + a thin human tab:
- `lib/dedup-critic-prompts.js` — `routeDedupCritic` (one specialty critic per pair, by taxon; agroecologist fallback) + `composeDedupPrompt` (a SAME-TAXON question, reusing the critic personas via `lib/critic-prompts.js::loadCriticIdentity`).
- `dedup-review-batch-prepare.js` → Claude Code Agents fill verdicts → `dedup-review-batch-import.js` writes `entity_dedup_verdicts` (migration 066) and applies the gate: `same`≥0.8 → `mergeCandidate` (the critic may correct the canonical), `distinct` → `rejected`, `uncertain`/low-conf → stays `pending`. Subscription-only, resumable (`NOT EXISTS` on verdicts), `--tier` runs `auto_safe` first.
- `lib/entity-dedup-admin.js` + `/api/admin/dedup/entities*` routes + an "Entity Dedup" tab in `admin-review.html` resolve the escalations (pending + uncertain/low-conf verdict, plus held `domain` pairs) — approve / keep-separate / undo, mirroring the variety-dedup tab.

"Needs human" is not a status — it is `pending` + an uncertain verdict (a JOIN); the `status` CHECK is unchanged.

# Known gaps (classifier tuning — follow-on #2)

- **Infraspecific rank markers are not normalized.** `structuralNorm` strips the `×` hybrid marker but NOT `var.`/`subsp.`/`ssp.`/`f.`/`forma`, so `Genus species var. epithet` and `Genus species epithet` are a duplicate class that slips **both** detectors (no slug collision — the `var-` token differs; the epithet sweep skips distance-0). Surfaced by the first production merge (`Brassica oleracea var. capitata` → the served `Brassica oleracea capitata`, same `gbif_key`; resolved as a manual one-off). Stripping rank markers in `structuralNorm` would auto-tier them like `×`-markers.
- **`pickCanonicalForDedup` mis-ranks same-`gbif_key` pairs.** When both rows carry the same `gbif_key` (definitive same-taxon), the anchor test ties and it falls through to data-mass — which can pick the *unserved/unclassified* row over the served, correctly-classified one. For same-key pairs, **served + classified should outrank data-mass** (overridden manually until fixed).
- **Distance-1 real-species residual.** Even with the unreliable-epithet guards, the `auto_safe` typo gate (epithet distance-1) keeps an irreducible tail of *genuinely distinct* congeners one edit apart — meaningful morphological prefixes like `Rubus microphyllus`/`macrophyllus`. Orthography can't separate these from typos; they need the human/critic review surface or a secondary signal. This is why the distance-1 epithet bulk is routed through review rather than blind-drained.

# Decomposition

Sub-project 1 (shipped): tiering + `auto_safe` drain + reversibility. Follow-on 2: a review surface (entity-dedup admin routes mirroring the variety tab) to drain `needs_review` + `domain`, plus the two classifier-tuning gaps above. Follow-on 3 (web-chat-coupled): rebuild + republish the merged served entities to live D1.

# Live-D1 reconciliation (follow-on #3)

A merge tombstones the loser (`entities.merged_into_entity_id`) + re-points its claim/trait
FKs to the canonical in the corpus; this publishes that to live D1. `gen-merge-d1-patch.cjs`
reads the **flattened `entities.merged_into_entity_id` pointer** (corpus truth) — one row per
served tombstone, `canon` = terminal — and emits an idempotent, GloBI-safe UPDATE patch:
tombstone the loser row + re-point its `claims`/`entity_trait_claims` FKs **by stable entity
id**. The generator aborts if any canonical is itself a tombstone (`assertNoTombstoneCanon`),
enforcing that `backend/flatten-merge-chains.js` runs before generation; unflattened multi-hop
chains would produce 404-redirect loops. The `entity_dedup_log` remains the reversal/audit
authority (faithful `unmergeEntity` by recorded claim ids); `merge-entity.js` now also writes
`entities.merged_into_entity_id` at merge time (merge-rail forwarding fix, 2026-06-27) so the
flattened pointer is always current. The `[slug]` SSR route 301-redirects a tombstone to its
canonical (`resolveMergeRedirect` + `getCanonicalSlug`); listing queries filter
`merged_into_entity_id IS NULL`; `build-d1.cjs` keeps served tombstones so a full rebuild
preserves the redirects. Reusable: the future `needs_review` merges reconcile through the same
ALTER → patch → deploy with no new code.

**Redirect targets must be LIVE pages, not just corpus-slugged (rail audit 2026-07-03).**
`assertNoTombstoneCanon` guards against *chains* but NOT against a canonical that isn't served
on D1 — a 301 to an unpublished canonical is a `301 -> 404` (fails safe, not a 500, but kills
live pages). So a **standalone `gen-merge-d1-patch` run is UNSAFE whenever a canonical is not
yet a live page**: the 2026-07-03 rail audit found a majority of the served-loser merges
targeted canonicals absent from live D1 (corpus-slugged-but-unpublished rows, plus a handful of
slug-NULL `×`-hybrid forms that are structurally unservable). **The merge reconciliation is
therefore gated on entity serving** — the same principle as claim/trait publishing in
[corpus-and-live-d1](/architecture/corpus-and-live-d1.md): serve the canonical pages first
(`serve-referenced-entities.js` / `gen-served-entities-patch.cjs`), THEN apply the merge patch.
**Open tool gap:** `selectServedMerges` needs a `canon.slug IS NOT NULL` (ideally live-served)
guard so unservable targets can't enter the patch; the `×`-hybrid canonicals need
slugging/re-pointing before their losers can be reconciled.

# Citations

[1] `docs/superpowers/specs/2026-06-23-entity-dedup-tiering-design.md`; plan `docs/superpowers/plans/2026-06-23-entity-dedup-tiering.md`.
[2] migrations 045 / 064 / 065; `lib/dedup-tier.js`; `merge-entity.js`.
