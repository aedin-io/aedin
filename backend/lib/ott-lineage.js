'use strict';
/**
 * ott-lineage.js — read a taxon's ancestor ranks out of ott.sqlite, and compare
 * them field-by-field with our stored columns.
 *
 * Pure comparison: it classifies, it never corrects. OTT's interleaved 'no rank'
 * clades (fabids, Holometabola) are additive phylogenetic nodes and are skipped.
 */
const LINNAEAN = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'];
const EXTRA = ['subfamily', 'tribe', 'superfamily', 'suborder', 'subphylum'];
const MAX_WALK = 60;

function lineageRanks(ottDb, ottId) {
  const get = ottDb.prepare('SELECT ott_id, parent_ott_id, name, rank FROM ott_taxa WHERE ott_id = ?');
  const out = {};
  let row = get.get(ottId);
  for (let i = 0; row && i < MAX_WALK; i++) {
    if (row.rank && (LINNAEAN.includes(row.rank) || EXTRA.includes(row.rank)) && !(row.rank in out)) {
      out[row.rank] = row.name;
    }
    if (row.parent_ott_id == null) break;
    row = get.get(row.parent_ott_id);
  }
  return out;
}

function compareFields(ours, theirs) {
  return LINNAEAN.map((field) => {
    const a = ours[field] || null;
    const b = theirs[field] || null;
    let verdict;
    let bothMissing = false;
    if (a && b) verdict = a === b ? 'agree' : 'differ';
    else if (!a && b) verdict = 'ours_missing';
    else if (a && !b) verdict = 'ott_missing';
    else { verdict = 'agree'; bothMissing = true; }
    return { field, ours: a, theirs: b, verdict, bothMissing };
  });
}

module.exports = { lineageRanks, compareFields, LINNAEAN, EXTRA };
