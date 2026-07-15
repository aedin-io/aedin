'use strict';

/**
 * globi-row-map.js — pure mapping from a GloBI CSV row to the `interactions`
 * insert tuple. Extracted from sync-globi.js so it is unit-testable without the
 * multi-GB download. Returns a 12-element array or null if the row should be
 * skipped.
 *
 * Tuple order matches the INSERT in sync-globi.js:
 *   [source_name, source_path, target_name, target_path, interaction_type,
 *    lat, lng, location,
 *    reference_citation, reference_doi, reference_url, source_citation]
 *
 * Citation header names follow GloBI's verbose interactions.csv. Each has a
 * snake_case fallback in case the dump variant differs. VERIFY against the live
 * dump header during the re-sync (docs/globi-resync-runbook.md).
 */

// Lowercased GloBI interaction types kept even without a location (literature-
// derived biocontrol relationships). Values are lowercased on purpose — iType is
// .toLowerCase()'d before lookup. (GloBI's actual casing: preysOn, parasiteOf,
// parasitoidOf, kills, pathogenOf, hasParasite, hasParasitoid, hasPathogen.)
const BIOCONTROL_TYPES = new Set([
  'preyson', 'parasiteof', 'parasitoidof', 'kills', 'pathogenof',
  'hasparasite', 'hasparasitoid', 'haspathogen',
]);

function nn(v) {
  // normalize '' / undefined → null; trim strings
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function buildInteractionTuple(row) {
  const sName = row.sourceTaxonName || row.source_taxon_name;
  const tName = row.targetTaxonName || row.target_taxon_name;
  const iType = (row.interactionTypeName || row.interaction_type || '').toLowerCase();

  if (!sName || !tName || sName === 'no name' || tName === 'no name') return null;

  // Drop REFUTED records: GloBI's argumentTypeId is a URI that is either
  // .../wiki/support (the interaction is asserted) or .../wiki/refute (a source
  // asserts the interaction does NOT occur). Ingesting a refute as a positive
  // edge would be a false positive — skip it. Absent/support → kept.
  if ((row.argumentTypeId || '').toLowerCase().includes('refute')) return null;

  const locName = row.localityName || row.locationName || row.localityId;
  const latRaw = row.decimalLatitude || row.latitude;
  const lngRaw = row.decimalLongitude || row.longitude;
  const hasLocation = !!(locName || (latRaw && lngRaw));
  if (!hasLocation && !BIOCONTROL_TYPES.has(iType)) return null;

  const lat = parseFloat(latRaw);
  const lng = parseFloat(lngRaw);

  return [
    sName,
    row.sourceTaxonPathNames || row.source_taxon_path || null,
    tName,
    row.targetTaxonPathNames || row.target_taxon_path || null,
    row.interactionTypeName || row.interaction_type || 'interactsWith',
    isNaN(lat) ? null : lat,
    isNaN(lng) ? null : lng,
    locName || null,
    nn(row.referenceCitation || row.reference_citation),
    nn(row.referenceDoi || row.reference_doi),
    nn(row.referenceUrl || row.reference_url),
    nn(row.sourceCitation || row.source_citation),
    // Resolved external taxon IDs (pipe-delimited, e.g. "GBIF:123 | NCBI:456").
    // GloBI already cross-resolves names against GBIF/NCBI/COL/ITIS/EOL/WD —
    // ~85% of rows carry a GBIF id. Captured so sync-gbif can skip re-matching.
    nn(row.sourceTaxonIds || row.source_taxon_ids),
    nn(row.targetTaxonIds || row.target_taxon_ids),
    // Life stage (dirty field — real stages mixed with source noise; store raw,
    // consume cautiously downstream for stage-dependent role assignment).
    nn(row.sourceLifeStageName || row.source_life_stage_name),
    nn(row.targetLifeStageName || row.target_life_stage_name),
    nn(row.eventDate || row.event_date),
    // Pre-split lineage from GloBI's name resolution (GBIF-backbone-derived):
    // genus/family/order/class/phylum/kingdom for source then target. Lets us
    // populate entities taxonomy from GloBI instead of re-parsing pathNames.
    nn(row.sourceTaxonGenusName || row.source_taxon_genus_name),
    nn(row.sourceTaxonFamilyName || row.source_taxon_family_name),
    nn(row.sourceTaxonOrderName || row.source_taxon_order_name),
    nn(row.sourceTaxonClassName || row.source_taxon_class_name),
    nn(row.sourceTaxonPhylumName || row.source_taxon_phylum_name),
    nn(row.sourceTaxonKingdomName || row.source_taxon_kingdom_name),
    nn(row.targetTaxonGenusName || row.target_taxon_genus_name),
    nn(row.targetTaxonFamilyName || row.target_taxon_family_name),
    nn(row.targetTaxonOrderName || row.target_taxon_order_name),
    nn(row.targetTaxonClassName || row.target_taxon_class_name),
    nn(row.targetTaxonPhylumName || row.target_taxon_phylum_name),
    nn(row.targetTaxonKingdomName || row.target_taxon_kingdom_name),
  ];
}

module.exports = { buildInteractionTuple, BIOCONTROL_TYPES };
