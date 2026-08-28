'use strict';
/**
 * subfamily-source.js — decide what entities.subfamily should hold for one
 * entity, given OTT's lineage for it and the family our corpus already stores.
 *
 * Usually this is a straight copy of OTT's subfamily. The interesting case is
 * a CLASSIFICATION-VINTAGE MISMATCH: OTT and AEDIN can carry the same taxon at
 * two different ranks because they follow classifications of different ages.
 *
 * Lymantriidae is the motivating case. OTT keeps the old family-rank concept
 * and has no `Lymantriinae` subfamily at all; AEDIN's `family` column holds the
 * modern `Erebidae`. Neither is wrong — they are the same group under two
 * schemes. A raw subfamily copy therefore returns NOTHING for 293 tussock
 * moths, and the ecological fact that matters (adults are aphagous) stays
 * unreachable. The bridge translates the old family name to the modern
 * subfamily name, which is what our modern-family corpus should hold.
 *
 * The bridge is CURATED and deliberately tiny — one entry per taxon actually
 * needed, never a general "demote any unmatched family" rule, which would
 * invent subfamilies wholesale. It fires only when our stored family is the
 * modern parent, the same old name, or absent; if our family is some unrelated
 * third family the row is likely mis-resolved and we abstain instead.
 */
const VINTAGE_BRIDGE = Object.freeze({
  // OTT family (old concept) -> what a modern-family corpus should store.
  Lymantriidae: { subfamily: 'Lymantriinae', modernFamily: 'Erebidae' },
});

function subfamilyFor(ottLineage, ourFamily) {
  const L = ottLineage || {};
  if (L.subfamily) return L.subfamily;              // OTT's own answer wins

  const bridge = L.family ? VINTAGE_BRIDGE[L.family] : null;
  if (!bridge) return null;
  const ok = !ourFamily || ourFamily === bridge.modernFamily || ourFamily === L.family;
  return ok ? bridge.subfamily : null;              // abstain on a third family
}

module.exports = { subfamilyFor, VINTAGE_BRIDGE };
