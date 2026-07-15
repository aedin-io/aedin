# AEDIN

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Data License: CC BY 4.0](https://img.shields.io/badge/Data%20License-CC%20BY%204.0-green.svg)](LICENSE-DATA) [![Website](https://img.shields.io/badge/website-aedin.io-brightgreen.svg)](https://aedin.io)

**AEDIN** (AgroEcological Database of Interactions) is an open agroecological knowledge base for academic researchers and AI consumer applications. It extracts atomic ecological claims — pest, pathogen, beneficial-insect, pollinator, mycorrhizal, soil, and crop-trait relationships — from open-access scientific literature using a large-language-model extraction pipeline, then verifies each claim through a **multi-critic AI consensus**: two independent specialty critics (an agroecologist plus a domain expert) must agree on plausibility, with no implausible verdict, before a claim is promoted to public visibility.

Verified claims are published at **[aedin.io](https://aedin.io)** with verbatim source quotes, page citations, and the full multi-critic verdict trail. Vocabulary is aligned with the [Global Biotic Interactions (GloBI)](https://www.globalbioticinteractions.org/) Relations Ontology so claims can be pushed back to the public GloBI corpus.

## Quick links

- 🌐 **Public site:** [aedin.io](https://aedin.io)
- 🗺️ **Project map & methodology:** [.okf/](.okf/index.md) — the Open Knowledge Format bundle documenting architecture, pipelines, datasets, and durable decisions
- 🏛️ **Architecture overview:** [ARCHITECTURE.md](ARCHITECTURE.md)
- 🧬 **Data model / interaction vocabulary:** [docs/vocabularies.md](docs/vocabularies.md)
- 📚 **Data sources & attribution:** [docs/data-sources-attribution-policy.md](docs/data-sources-attribution-policy.md)
- 📄 **Data license** (claims, metadata, verdicts): [CC BY 4.0](LICENSE-DATA)
- 💻 **Code license:** [MIT](LICENSE)
- 📖 **Citation:** [CITATION.cff](CITATION.cff) — GitHub renders a "Cite this repository" button

## How a claim gets here

1. An open-access PDF is chunked; a large-language-model extracts atomic claims with verbatim quotes and page citations.
2. A first-pass critic (Haiku-tier) classifies each claim as **plausible / implausible / uncertain / out-of-scope**.
3. Two independent specialty critics — an agroecologist plus a domain expert (entomologist, plant-pathologist, soil-scientist, or horticulturist) — re-evaluate.
4. Only claims with ≥2 plausible verdicts and zero implausible verdicts are promoted to public visibility.

The critic prompts themselves are open — see [.claude/agents/](.claude/agents/).

## Project structure

```
aedin/
├── backend/   Node.js/Express API + LLM extraction & multi-critic pipeline (CommonJS)
├── web/       Public static site — Astro 5 + Tailwind 4 + better-sqlite3
├── .okf/      Open Knowledge Format bundle — the navigable project map
└── docs/      Data model, methodology, and source-attribution reference
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for a fuller overview.

## Running locally

```bash
# Backend (API server, port 3001)
cd backend && npm install && npm start

# Web (static site, port 3000)
cd web && npm install && npm run dev
```

You'll need a recent Node.js (≥ 20). The backend reads a curated SQLite corpus (`backend/aedin.sqlite`). The raw GloBI source (`backend/globi.sqlite`, large) is rebuilt from the public GloBI dump via `npm run sync-global`. Both database files are generated locally and are not tracked in git.

## Citing AEDIN

If you use AEDIN's data, claims, or methodology in your research, please cite it. The recommended citation is in [CITATION.cff](CITATION.cff); GitHub renders a "Cite this repository" button you can use directly. A persistent Zenodo DOI is pending registration.

## License posture (three layers)

- **AEDIN's own metadata** (claim records, entity records, multi-critic verdicts, aggregate analysis) — [CC BY 4.0](LICENSE-DATA). Cite AEDIN when reusing.
- **Verbatim source quotes** shown on individual claim pages retain the license of the original source publication. Each quote displays its source license badge alongside it.
- **Site code** (extraction pipeline, public web site, administrative tooling) — [MIT](LICENSE).

## Status

The public web surface at [aedin.io](https://aedin.io) is live. The multi-critic AI extraction pipeline continues to ingest open-access literature. Funding is being sought to support next development phases — human-reviewer onboarding, corpus expansion beyond open-access PDFs, and an MCP server interface so other agentic systems can query verified claims with full provenance.

**Important provenance note:** Claims published here are AI-vouched by multi-critic consensus but **not yet human-verified**. Each claim links to its verbatim source quote — verify against the source before publishing or citing in your own work.

## Contact

[contact@aedin.io](mailto:contact@aedin.io) · [aedin.io](https://aedin.io)
