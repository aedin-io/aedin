# AEDIN — Architecture

A short technical overview of how AEDIN turns unstructured agroecological
literature into a verified, citable knowledge graph. For the full navigable
map — per-subsystem concepts, datasets, and durable design decisions — read the
Open Knowledge Format bundle at [.okf/index.md](.okf/index.md).

## What AEDIN is

AEDIN is a **data engine**: raw substrate flows through AI-assisted extraction,
multi-pass verification, and provenance tracking to produce a structured,
citable knowledge graph of ecological interactions (pest, pathogen, beneficial,
pollinator, mycorrhizal, soil, and crop-trait relationships). Every promoted
claim carries a verbatim source quote, a page citation, and the full
multi-critic verdict trail.

## Components

- **`backend/`** — Node.js / Express (CommonJS). Hosts the REST API
  (`server.js`), the LLM extraction pipeline, the multi-critic consensus
  tooling, and the sequential SQLite migrations under `backend/migrations/`.
- **`web/`** — the public static site (Astro 5 + Tailwind 4). Reads a served
  subset of the corpus; deployed to Cloudflare Pages with the served data
  mirrored to Cloudflare D1.
- **Corpus** — a curated SQLite database (`backend/aedin.sqlite`) is the source
  of truth for entities, claims, and verdicts. The raw GloBI source
  (`backend/globi.sqlite`) is a large, separately-synced download. Both are
  generated locally and are not tracked in git.
- **`.okf/`** — the Open Knowledge Format bundle: the canonical, navigable
  description of every pipeline, dataset, and durable decision.

## Data flow

1. **Raw ingestion** — the public GloBI interaction dump is streamed into
   SQLite; open-access literature PDFs are chunked (`pdf-chunk.js`).
2. **Extraction** — a large-language-model extracts atomic claims from each
   chunk, each with a verbatim quote and page citation, into a staging table.
3. **First-pass vouch** — a lightweight critic classifies each staged claim as
   plausible / implausible / uncertain / out-of-scope.
4. **Multi-critic consensus** — each claim is routed to two independent
   specialty critics: an **agroecologist** synthesizer plus one domain expert
   (**entomologist, plant-pathologist, soil-scientist, horticulturist, or
   wildlife-ecologist**) selected by the claim's content.
5. **Promotion gate** — only claims with **≥2 plausible verdicts and zero
   implausible verdicts**, that also resolve to a locality and to a taxonomic
   rank no coarser than family/order, are promoted to public visibility.
6. **Serving** — promoted claims are published via the web site and mirrored to
   Cloudflare D1, each linking to its source quote, citation, and verdict trail.

The critic personas are open and live as prompt-as-data under
[.claude/agents/](.claude/agents/).

## Provenance

Every programmatic mutation of a claim or entity is recorded in a `revision_log`
audit trail (taxonomy re-resolution, reclassification, quarantine) and surfaced
on each entity/claim page as a modification history. The served (public) dataset
is a subset — quarantined or removed claims are intentionally omitted.

## Further reading

- [.okf/index.md](.okf/index.md) — full project map (start here)
- [docs/vocabularies.md](docs/vocabularies.md) — the interaction/relation vocabulary (data model)
- [docs/multi-agent-architecture.md](docs/multi-agent-architecture.md) — the multi-critic design in depth
- [docs/data-sources-attribution-policy.md](docs/data-sources-attribution-policy.md) — source licensing & attribution
