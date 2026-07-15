# Agroecologist & specialist-agent reference corpus

Five reviewer agents (Agroecologist as synthesizer, Plant Pathologist, Entomologist, Soil Scientist, Horticulturist) consult this directory for citation-grounded review. See `../../../docs/multi-agent-architecture.md` for the routing rules and `../../agroecologist.md` (and the four specialist `.md` files in `.claude/agents/`) for the agent specs.

## What's tracked in git

- **`principles.md`** — distilled cross-source framework. Always loaded first.
- **`*_toc.md`** — table-of-contents for each book in the corpus (Gliessman, Rickerl & Francis, Andow, Dieckmann). Small, low-copyright-risk.
- **This `README.md`**.

## What's NOT tracked (gitignored)

- **`*_full_text.md`** (~28 MB across 21 files) — verbatim text extracted from the source PDFs. Excluded from git for copyright reasons. The agents *do* grep these files locally. They must be regenerated after a fresh clone.

## Regeneration after a fresh clone

1. Acquire the source PDFs (see `docs/corpus-expansion-recommendations.md` for the full bibliography of the 21-book + 2-paper corpus). Place them under `agroecology_books/` matching the structure documented there.
2. Run the extraction:

   ```bash
   cd backend
   node tools/extract_corpus.js
   ```

3. Verify: `ls -la .claude/agents/agroecologist/reference/*_full_text.md` should show all 21 files.

Total extraction time on a workstation: ~25 seconds. The script is idempotent — re-running won't re-extract files that already have non-empty output (allows incremental adds).

## Indexing into context-mode (optional, for grep-cost optimization)

After extraction, optionally index each file into context-mode for faster searches:

```bash
# In a Claude Code session:
ctx_index path:".claude/agents/agroecologist/reference/<name>_full_text.md" source:"<short label>"
```

Indexing is per-session; re-runs after `/clear` or fresh sessions need the indexes rebuilt. The agents fall back to direct `Grep` if FTS5 indexes aren't available.

## Corpus inventory (21 books + 2 papers as of 2026-05-01)

See `docs/corpus-expansion-recommendations.md` for the full annotated list and per-source provenance. By specialty:

- **Agroecology general** (7): Gliessman 3rd, Gliessman 4th, Altieri, Rickerl & Francis, Giampietro, Medicinal Agroecology, Chalker-Scott Companion-Planting Myth
- **Entomology / IPM** (6 PDFs + 1 EPUB): Pedigo, Dent, Omkar Insect Predators, Omkar Parasitoids, Andow, Gurr Ecological Engineering, Abrol IPM (EPUB, not yet extracted)
- **Plant pathology** (1): Agrios 5th
- **Soil science** (2): Brady & Weil 15th, Magdoff & van Es Building Soils 4th
- **Crop ecology / horticulture** (2): Loomis & Connor, Agroforestry in Sustainable Agricultural Systems
- **Spatial ecology** (1): Dieckmann/Law/Metz Geometry of Ecological Interactions
- **Papers** (2): Tamburini 2024, Martinez 2024

## Notes for collaborators

- **The agent specs (`*.md` files in `.claude/agents/`) are the public artifacts.** They define how each reviewer thinks; they're tracked in git.
- **The reference corpus is your local fuel.** Without it, agents can still run but will be unable to cite specific passages — they'll mark every claim "(from general knowledge, not verified in corpus)" per the calibration rules.
- **License vetting is a Phase-5 deliverable** (per the gap analysis). For now, treat all verbatim quotes as fair-use snippets used internally for review; they should NOT be exposed via the public consumer-facing API until each source's license is reviewed.
