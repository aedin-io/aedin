'use strict';
/**
 * ott-lookup.js — candidate lookup and kingdom derivation against ott.sqlite.
 *
 * Searches taxonomy AND synonyms. The bare binomial of a plant is frequently a
 * SYNONYM in OTT while the accepted name carries an authority string, and the
 * same bare string may be an accepted ANIMAL name — "Ficus variegata" is the
 * mollusc in ott_taxa and the fig only via ott_synonyms. Searching one table
 * would silently return the wrong kingdom with no ambiguity signal.
 */

// OTT top-level names -> AEDIN bio_category vocabulary. OTT is phylogeny-first,
// so its roots are clades (Archaeplastida, Metazoa) rather than Linnaean kingdoms.
const OTT_KINGDOM_MAP = Object.freeze({
  Archaeplastida: 'plantae',
  Chloroplastida: 'plantae',
  Viridiplantae: 'plantae',
  Fungi:          'fungi',
  Nucletmycea:    'fungi',
  Metazoa:        'invertebrate',
  Bacteria:       'microbe',
  Archaea:        'microbe',
});

const MAX_WALK = 60;

function kingdomOf(ottDb, ottId) {
  const get = ottDb.prepare('SELECT ott_id, parent_ott_id, name FROM ott_taxa WHERE ott_id = ?');
  let row = get.get(ottId);
  for (let i = 0; row && i < MAX_WALK; i++) {
    const mapped = OTT_KINGDOM_MAP[row.name];
    if (mapped) return mapped;
    if (row.parent_ott_id == null) break;
    row = get.get(row.parent_ott_id);
  }
  return null;
}

function candidatesFor(ottDb, name) {
  const rows = ottDb.prepare(`
    SELECT t.ott_id, t.name, t.rank, t.flags
    FROM ott_taxa t WHERE t.name = ?
    UNION
    SELECT t.ott_id, t.name, t.rank, t.flags
    FROM ott_synonyms s JOIN ott_taxa t ON t.ott_id = s.ott_id
    WHERE s.name = ?`).all(name, name);
  return rows.map(r => ({ ...r, kingdom: kingdomOf(ottDb, r.ott_id) }));
}

module.exports = { candidatesFor, kingdomOf, OTT_KINGDOM_MAP };
