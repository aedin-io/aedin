# Guam re-ingest campaign — resume hand-off

**Last live activity:** 2026-05-30, mid wave-M dispatch. Session-limit cap approaching.

## State on disk

- **Batches:** `backend/critic-batches/batch-{000..100}.json` (101 MC batches, durable).
- **Verdicts that already landed:** `backend/critic-verdicts/batch-NNN.json` — varying counts across waves A through L/M, all valid top-level JSON arrays of 16 verdicts each (last batch may be smaller). Treat the directory as source of truth — re-running `multi-critic-batch-import.js` is idempotent (`INSERT OR IGNORE` on `(staging_id, critic_name)`).
- **Patched scripts (committed env-var override):**
  - `backend/multi-critic-batch-prepare.js` — honors `BATCH_OUT_DIR`
  - `backend/multi-critic-batch-import.js` — honors `BATCH_OUT_DIR` + `VERDICTS_DIR`

## State in DB (`backend/globi.sqlite`)

- **Sources 68 + 69** (Guam papers) — original `claims` already deleted by `reset-sources-for-reingest.js` (timestamped JSON backup under `backend/backups/`).
- **`extraction_staging`** rows from the fresh re-ingest are vouched: 802 plausible+uncertain.
- **`claim_critic_verdicts`** has 384 rows from waves 1-3 (192 staging rows × 2 critics) imported earlier.
- Waves A through (wherever the session cap caught us) still need importing — files are on disk under `backend/critic-verdicts/`.

## Resume checklist

```bash
cd /home/beef/projects/aedin/backend

# 1. Import all verdict files into claim_critic_verdicts
BATCH_OUT_DIR=./critic-batches VERDICTS_DIR=./critic-verdicts \
  node multi-critic-batch-import.js

# 2. Check how many un-verdicted staging rows remain
sqlite3 globi.sqlite "
  SELECT COUNT(*) FROM extraction_staging s
  WHERE s.source_id IN (68,69)
    AND s.ai_vouch_status IN ('plausible','uncertain')
    AND NOT EXISTS (SELECT 1 FROM claim_critic_verdicts v WHERE v.staging_id=s.id);
"

# 3. If un-verdicted rows remain, re-prep + dispatch missing batches
#    (the prepare script auto-excludes rows already verdicted via NOT EXISTS)
BATCH_OUT_DIR=./critic-batches node multi-critic-batch-prepare.js \
  --source-id=68 --batch-size=8
# (and again with --source-id=69 if needed; rename + merge as during this session)

# 4. Promote consensus-passing rows
node promote-staged-claims.js

# 5. Validate species-resolution fix in promoted claims
sqlite3 globi.sqlite "
  SELECT id, subject_name, object_name, source_quote
  FROM claims
  WHERE source_id IN (68,69)
    AND (subject_name LIKE '%Ralstonia%' OR object_name LIKE '%Ralstonia%')
  LIMIT 20;
"
```

## Key findings from this campaign

1. **Species-resolution fix is validated.** Ralstonia normalization confirmed across batches 069, 077, 078 — both critics independently accepted multiple host pairings (soursop, ironwood, banana, pepper). The professor's flagged bug is closed.
2. **Multi-critic gate caught real extraction errors** (would have slipped past single-critic vouch):
   - Plutella xylostella (Brassicaceae specialist) mis-attributed to garlic (batch 024) AND lettuce (batches 041, 043). Same systemic extraction artifact across three host crops.
   - Phyllocnistis citrella (citrus leafminer, Gracillariidae) mis-classified as Agromyzidae (batches 038, 046, 058) — three independent flags.
   - Flea beetles on citrus (batch 046) — both critics implausible (Chrysomelidae specialists target Solanaceae/Brassicaceae).
3. **Router mis-routes** are a known noise source — plant-pathologist returns OOS on arthropod claims, horticulturist returns OOS on pathogen claims. Affected rows simply don't promote (single-plausible doesn't meet ≥2 gate). Fix is in CLAUDE.md backlog.

## Avoid

- **Do NOT dispatch more agents until you've confirmed the rate-limit window has reset** (last cap was tied to Pacific/Port_Moresby 11:50). Session-limited dispatches return tokens=0 in tens of seconds — wasteful but not harmful.
- **Do NOT re-run `multi-critic-batch-prepare.js` against a dir that already holds the current batches** — it `unlinkSync`s `batch-*.json` first. The 101 batches were assembled by merging two source dirs; preserve them.
- **Do NOT touch `/tmp/claude/`** — the previous wipe lost ~16 wave-4+5 verdict files. All durable artifacts are now under `backend/`.

## Outstanding work after wave M completes

- Commit + push: `backend/render-extractor-prompt.js`, `backend/reset-sources-for-reingest.js`, env-var patches in `multi-critic-batch-prepare.js` and `multi-critic-batch-import.js`, and this resume note.
- Document the campaign outcome in `docs/phase-3-passlog.md` (Pass 12+: Guam re-ingest).
- Begin next regional batch (Pacific Pests after Guam) following the same playbook.
