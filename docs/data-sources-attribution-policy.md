# Data Sources & Attribution Policy

**Purpose**: Source-of-truth for what data AEDIN pulls from each
upstream, how it's licensed, how attribution is surfaced on the
public site, in API responses, and in the Terms of Service.

**Companion to**: `subscription-prep-database-website.md` (the
public-vs-gated frame); `nsf-sbir-team-recruitment.md` (Jorrit /
GloBI relationship context).

---

## Three categories of upstream — three attribution patterns

| Category | Examples | Attribution mechanism |
|---|---|---|
| Programmatic data source | GloBI, GBIF, Wikidata, Trefle, GRIN, Open-Meteo, SoilGrids | `/data-sources` page entry + per-record `source_attribution` field in API responses |
| Literature source | OA journal articles, extension bulletins, books (UOG extension, Rubatzky, etc.) | Per-claim verbatim quote + full citation (already implemented in `/claim/[id]` and `/globi/[id]`) |
| Standard / ontology | GloBI Relations Ontology, Darwin Core, GBIF backbone taxonomy, USDA PLANTS naming | "We conform to" block on `/data-sources` |

Don't conflate them. They have different legal weight and different
positioning value.

---

## The full upstream list

### Programmatic data sources

#### GloBI (Global Biotic Interactions)
- **Role**: Substrate interaction dataset. ~212,000 federated
  interactions tagged `tier2_globi` in the served data.
- **License**: Aggregate is mostly CC0; individual records inherit
  upstream-dataset licenses (often CC-BY). Treat as CC-BY by default
  for safety.
- **Citation**: Poelen JH, Simons JD, Mungall CJ. 2014. Global biotic
  interactions: An open infrastructure to share and analyze
  species-interaction datasets. *Ecological Informatics* 24:148–159.
- **Sync mechanism**: `backend/sync-globi.js`
- **URL**: https://www.globalbioticinteractions.org/
- **Surfaced as**: `/globi/[id]` pages + "via GloBI" label on
  landing-page holdings stat + Relations Ontology vocab link.

#### GBIF (Global Biodiversity Information Facility)
- **Role**: Taxonomic backbone — accepted-name resolution,
  higher-rank assignment, taxon keys. Resolves binomials to canonical
  taxonomy.
- **License**: GBIF backbone is CC-BY 4.0.
- **Citation**: GBIF Secretariat. 2025. GBIF Backbone Taxonomy.
  Checklist dataset https://doi.org/10.15468/39omei accessed via
  GBIF.org.
- **Sync mechanism**: `backend/sync-gbif.js`, `lib/gbif-resolve.js`
- **URL**: https://www.gbif.org/
- **Surfaced as**: Taxonomy fields on entity pages + the
  `gbif_taxon_key` link-out where present.

#### Wikidata
- **Role**: Multilingual common-name enrichment, cross-identifier
  bridging (Wikipedia, EPPO codes, GBIF keys, NCBI taxon).
- **License**: CC0 — no attribution legally required, but conventional
  to credit.
- **Citation**: Wikidata contributors. Wikidata: A free collaborative
  knowledgebase. Communications of the ACM 57(10):78–85.
- **Sync mechanism**: `backend/sync-wikidata.js`
- **URL**: https://www.wikidata.org/
- **Surfaced as**: Common-name field on entity pages.

#### Trefle
- **Role**: Plant-trait enrichment (growth, climate, soil
  preferences).
- **License**: Free public API with attribution. Active and
  operational.
- **Citation**: Trefle.io (https://trefle.io).
- **Sync mechanism**: `backend/sync-trefle.js`
- **URL**: https://trefle.io
- **Surfaced as**: Plant trait values on entity pages.

#### USDA GRIN-Global (Germplasm Resources Information Network)
- **Role**: Crop variety / cultivar data. Public-domain US government
  work.
- **License**: US government public domain.
- **Citation**: USDA Agricultural Research Service, GRIN-Global
  (https://npgsweb.ars-grin.gov/gringlobal/search).
- **Sync mechanism**: `backend/sync-grin-varieties.js`
- **URL**: https://npgsweb.ars-grin.gov/gringlobal/
- **Surfaced as**: Variety information on crop entity pages.

#### Open-Meteo
- **Role**: Climate-grid data (temperature, precipitation, GDD).
- **License**: CC-BY 4.0. ATTRIBUTION REQUIRED.
- **Citation**: Zippenfenig P. 2023. Open-Meteo.com Weather API.
  https://doi.org/10.5281/zenodo.7970649
- **Sync mechanism**: `backend/sync-climate-grid.js`
- **URL**: https://open-meteo.com/
- **Surfaced as**: Climate envelope data on region pages + site-profile
  endpoint.

#### SoilGrids (ISRIC)
- **Role**: Global gridded soil information (pH, organic carbon,
  texture, etc.).
- **License**: CC-BY 4.0. ATTRIBUTION REQUIRED.
- **Citation**: Poggio L, de Sousa LM, Batjes NH, Heuvelink GBM,
  Kempen B, Ribeiro E, Rossiter D. 2021. SoilGrids 2.0: producing
  soil information for the globe with quantified spatial
  uncertainty. *SOIL* 7:217–240.
- **Sync mechanism**: `backend/sync-climate-grid.js` (combined with
  Open-Meteo)
- **URL**: https://soilgrids.org/
- **Surfaced as**: Soil section of site-profile + region pages.

### Literature sources (per-claim attribution)

These are NOT cataloged on the `/data-sources` page because they
already have their own attribution surface (every claim page shows
the verbatim quote + full citation). The list of literature sources
is dynamic and grows with each ingestion pass.

But add this single block to `/data-sources`:

> **Scientific literature**: AEDIN has extracted atomic claims
> from 200+ open-access papers, extension bulletins, and books.
> Each individual claim is attributed to its source on the claim
> page (`/claim/[id]`), with verbatim quote, page number, full
> citation, and link to the original. Major recurring source
> categories include: peer-reviewed open-access journals (Annals of
> the Entomological Society of America, Journal of Economic
> Entomology, BioControl, others); university extension publications
> (University of Guam, University of Florida IFAS, University of
> Hawaii CTAHR, USDA SARE); and standard reference works (Rubatzky &
> Yamaguchi, *World Vegetables*; others as cited per-claim).

ESA (Entomological Society of America) journals — if claims have
been extracted from articles published there, they appear as
per-claim citations. Same for ESA (Ecological Society of America).

### Standards & ontologies (conformance, not data)

- **GloBI Relations Ontology**: interaction vocabulary
  (`predatorOf`, `parasitoidOf`, `pollinates`, etc.) follows GloBI's
  controlled vocab so AEDIN data is interoperable with GloBI's
  ecosystem.
- **Darwin Core**: standard biodiversity-data terms used in entity
  records (`scientificName`, `taxonRank`, etc.).
- **GBIF backbone taxonomy**: canonical taxonomic structure used in
  entity records.
- **USDA PLANTS Database naming** (where applicable): canonical
  US-centric crop-name conventions.

---

## What to build on aedin.io

### 1. `/data-sources` page (new)

Single page. One section per upstream source above. Each entry has:
- Source name + role (one sentence)
- License + attribution requirement clearly stated
- Citation block (formatted for copy-paste into a paper)
- Link to upstream
- A small "How AEDIN uses this" note

Order: GloBI → GBIF → Wikidata → Trefle → GRIN → Open-Meteo →
SoilGrids → Literature → Standards.

Style: same nature/earth Tailwind palette as the rest of the site.
Don't make this a marketing page — make it a reference page that
reads like academic methods documentation. THAT'S the credibility
signal.

### 2. Add `source_attribution` field to API responses

For every record returned from `/api/v1/*`, include:

```json
{
  "id": "globi:1234567",
  "source_attribution": {
    "tier": "tier2_globi",
    "aggregator": {
      "name": "Global Biotic Interactions (GloBI)",
      "url": "https://www.globalbioticinteractions.org/",
      "citation": "Poelen et al. 2014",
      "license": "CC0 (record-level licenses may apply)"
    },
    "upstream_dataset": "...",
    "upstream_record_url": "..."
  }
}
```

For verified literature claims:

```json
{
  "id": "claim:42",
  "source_attribution": {
    "tier": "tier1_paper",
    "primary_source": {
      "type": "literature",
      "citation": "Smith et al. 2024",
      "doi": "...",
      "url": "..."
    },
    "agroeco_provenance": {
      "extraction_method": "ai_consensus_verified",
      "critics": ["agroecologist", "entomologist"],
      "verified_at": "2026-04-15"
    }
  }
}
```

This makes attribution programmatic and pushes the obligation cleanly
downstream.

### 3. Update `/about` citation guidance

Add a "How to cite AEDIN" block with:
- AEDIN-as-aggregator citation (your own canonical reference,
  whatever you settle on — likely a DOI on Zenodo or similar)
- Note that when reusing data sourced from a specific upstream,
  cite both AEDIN AND the upstream
- Link to `/data-sources` for full upstream catalog

### 4. Update Terms of Service (when written)

Section X.Y on attribution: "Subscriber agrees to preserve and
display source attribution as provided in `source_attribution`
fields of API responses, and to follow the attribution requirements
of each upstream source as documented at aedin.io/data-sources."

### 5. (Stretch) DOI registration

Register a DOI for the AEDIN knowledge base via Zenodo. This makes
AEDIN itself citeable in academic papers and matches what GBIF,
GloBI, OpenAlex, and CABI all do. Free, takes ~30 minutes.

---

## Why this is genuinely good for the business

1. **Marketing**: `/data-sources` is the page a sophisticated buyer
   reads before paying you. It proves the curation work is real and
   the data lineage is auditable. CABI hides its data partners; you
   can use radical transparency as a positioning advantage CABI
   structurally can't match.
2. **Sales**: when an academic library buyer asks "what's in this?"
   you point them to one page that answers everything. Faster sales
   cycle.
3. **Trust**: provenance is what academic markets pay for. The page
   is the proof.
4. **Legal**: pre-empts every "you didn't credit my data" complaint
   from upstream sources or downstream subscribers.
5. **Community**: GloBI, GBIF, EPPO, Open-Meteo all maintain
   community goodwill toward downstream users who attribute properly.
   You stay in their good graces, which is worth real long-term value
   (collaborations, letters of support, conference invitations,
   inbound talent).

---

## Open audit items before launch

- [ ] Review all currently-public-facing surfaces before monetizing
      and decide what stays public, what's gated, and what may have
      attribution-conflict issues that aren't already known.
- [ ] Register a Zenodo DOI for the AEDIN knowledge base.
- [ ] Audit the literature corpus for any non-open-access sources
      that may have been ingested in error.
- [ ] Add `source_attribution` field design to the OpenAPI spec
      before launching the paid API.
