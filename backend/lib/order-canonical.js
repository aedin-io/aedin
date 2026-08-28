'use strict';
/**
 * order-canonical.js — the canonical order for a family, per the Open Tree
 * Taxonomy, and a classification of how our stored value disagrees with it.
 *
 * WHY: AEDIN's corpus mixes taxonomic systems, so one family routinely carries
 * two order names — Englerian beside APG (`Polycarpicae`/`Ranunculales`), and
 * pre- beside post-split fungal orders (`Mycosphaerellales`/`Capnodiales`).
 * `taxon_order` cannot be validated against `family` internally, because both
 * fields come from the same imperfect sources; an external tree can.
 *
 * TWO KINDS OF DISAGREEMENT, and they are not the same problem:
 *
 *   archaic   — our value is not an order in OTT AT ALL. Either a superseded
 *               name (Polycarpicae, Centrospermae, Terebinthales) or a real
 *               taxon at the WRONG RANK (Psocodea is a superorder, so it does
 *               not belong in taxon_order regardless of currency). Correcting
 *               these is unambiguous.
 *   contested — both names are real OTT orders and OTT has simply placed the
 *               family under one of them. Mycosphaerellales vs Capnodiales,
 *               Pinales vs Cupressales. Adopting OTT here is PICKING A SIDE in
 *               a live scientific disagreement, not fixing an error.
 *
 * The corpus adopts OTT for both (owner decision, 2026-08-25), but the classes
 * are recorded separately in revision_log so the contested subset can be
 * reviewed — or reverted — independently of the unambiguous one.
 */
const MAX_WALK = 40;

/**
 * @param {object} ottDb better-sqlite3 handle on ott.sqlite
 * @param {string} family
 * @returns {string|null} the order containing this family, or null
 */
function canonicalOrderForFamily(ottDb, family) {
  if (!family) return null;
  const start = ottDb.prepare("SELECT ott_id FROM ott_taxa WHERE name = ? AND rank = 'family'").get(family);
  if (!start) return null;
  const get = ottDb.prepare('SELECT ott_id, parent_ott_id, name, rank FROM ott_taxa WHERE ott_id = ?');
  let node = get.get(start.ott_id);
  for (let i = 0; node && i < MAX_WALK; i++) {
    if (node.rank === 'order') return node.name;
    if (node.parent_ott_id == null) break;
    node = get.get(node.parent_ott_id);
  }
  return null;
}

/**
 * @returns {'agree'|'archaic'|'contested'}
 */
function classifyDisagreement(ottDb, ours, canonical) {
  if (!canonical || !ours || ours === canonical) return 'agree';
  const known = ottDb.prepare("SELECT COUNT(*) c FROM ott_taxa WHERE name = ? AND rank = 'order'").get(ours);
  return known.c > 0 ? 'contested' : 'archaic';
}

module.exports = { canonicalOrderForFamily, classifyDisagreement, MAX_WALK };
