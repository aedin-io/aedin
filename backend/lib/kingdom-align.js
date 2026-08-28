'use strict';
/**
 * kingdom-align.js — compare our stored entities.bio_category against the
 * kingdom OTT places an entity in, and say what kind of difference it is.
 *
 * It CLASSIFIES; it never applies. The caller decides what a verdict earns:
 * a `fill` is safe to apply (we held no opinion), a `contradiction` is not
 * (we hold an opinion that our own curated genus lists may back over OTT's).
 *
 * The vertebrate split is the reason this module exists rather than a direct
 * read of OTT_KINGDOM_MAP: that map collapses all of Metazoa to 'invertebrate',
 * which is a correct KINGDOM answer but a wrong bio_category value for every
 * vertebrate. OTT names `Vertebrata` explicitly in the ancestry, so we test for
 * it by name — testing on Chordata instead would call tunicates vertebrates.
 */
const MAX_WALK = 60;
const VERTEBRATA = 'Vertebrata';
const ANIMAL = new Set(['invertebrate', 'vertebrate']);
const BLANK = new Set([null, undefined, '', 'other', 'unknown']);

function animalSubcategory(ottDb, ottId) {
  const get = ottDb.prepare('SELECT parent_ott_id, name FROM ott_taxa WHERE ott_id = ?');
  let row = get.get(ottId);
  for (let i = 0; row && i < MAX_WALK; i++) {
    if (row.name === VERTEBRATA) return 'vertebrate';
    if (row.parent_ott_id == null) break;
    row = get.get(row.parent_ott_id);
  }
  return 'invertebrate';
}

function classifyKingdomDelta(ottDb, { ours, ottKingdom, ottId }) {
  // No external verdict means no finding — abstain rather than invent one.
  if (!ottKingdom) return { verdict: 'agree', value: null };

  const value = ottKingdom === 'invertebrate' ? animalSubcategory(ottDb, ottId) : ottKingdom;

  if (BLANK.has(ours || null)) return { verdict: 'fill', value };
  // A stored 'vertebrate' does not contradict OTT's Metazoa: it is the same
  // fact stated more finely, so both animal values agree with an animal verdict.
  if (ottKingdom === 'invertebrate' && ANIMAL.has(ours)) return { verdict: 'agree', value };
  if (ours === ottKingdom) return { verdict: 'agree', value };
  return { verdict: 'contradiction', value };
}

module.exports = { classifyKingdomDelta, animalSubcategory };
