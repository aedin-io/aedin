'use strict';
/**
 * ott-resolve.js — decide which OTT taxon an AEDIN entity is.
 *
 * Disambiguate-or-abstain, mirroring lib/gbif-resolve.js. Abstention is a
 * correct outcome: 'ambiguous' is a real answer, not a failure.
 *
 * The tiebreak uses ONLY curated genus name lists. It must NEVER use
 * bio_category, the stored kingdom, or claim context — for the collision cases
 * those are derived from the corrupt value, so they would confidently select
 * the wrong homonym exactly where correctness matters most. (See the reverted
 * 2026-06-10 --corrupt-globi attempt.)
 *
 * Pure: candidates in, a decision out. No I/O.
 */
const { BACTERIAL_GENERA, FUNGAL_GENERA } = require('./curated-genera.js');
const { EXTRA_FUNGAL_GENERA } = require('./phylum-validator.js');

// Plant genera that GBIF mis-resolves to an animal namesake. This is a
// DELIBERATE FORK of lib/phylum-validator.js's PLANT_GENERA, not a mirror of
// it — that list also carries 'stelis', which is excluded here on purpose.
// Stelis is genuinely both an orchid genus and a bee genus; there is no
// curated answer, so a Stelis binomial must abstain rather than guess (see
// the 'Stelis' golden case below and in ott-resolve.test.js). Fungal
// coverage is NOT forked the same way — EXTRA_FUNGAL_GENERA is imported
// directly from phylum-validator.js below so the two modules' fungal
// collision lists (Cyathus, Amanita, …) stay in sync; only the plant-genus
// set is deliberately narrower here.
const PLANT_GENERA = new Set([
  'ficus', 'dacrydium', 'chloris', 'lycopersicon', 'solanum', 'prunus',
  'quercus', 'acacia', 'eucalyptus', 'citrus', 'vitis', 'oryza', 'triticum', 'zea',
  'glycine', 'phaseolus', 'brassica', 'allium', 'capsicum', 'cucumis', 'cucurbita',
  'mangifera', 'musa', 'carica', 'persea', 'coffea', 'theobroma', 'pinus', 'abies',
  'picea', 'populus', 'salix', 'acer', 'betula', 'fraxinus', 'ulmus', 'rosa',
]);

// OTT quality markers that make a candidate weaker than an unflagged sibling.
const WEAK_FLAGS = ['incertae_sedis', 'barren', 'hidden', 'extinct', 'was_container', 'not_otu'];

/** Trailing authority, e.g. "Blume, 1825" or "(L.) Merr." */
const AUTHORITY_RE = /\s+(\(.*?\)\s*)?[A-Z][A-Za-z.'-]*(\s+(&|et|and|ex)\s+[A-Z][A-Za-z.'-]*)*(\s*,\s*\d{4})\s*$/;
const RANK_MARKER_RE = /\b(subsp|ssp|var|f|forma|cv)\.\s*/gi;

function normalizeName(name) {
  if (!name) return '';
  let s = String(name).trim();
  s = s.replace(AUTHORITY_RE, '');
  // Hybrid markers. The ASCII x/X is as common as the true × in this corpus
  // ('Citrus X limonia'), and OTT stores these without the marker. Both forms
  // must be STANDALONE — surrounded by whitespace — so a legitimate epithet
  // beginning with x (Rosa xanthina, Carex xerantica) is never touched.
  s = s.replace(/^[×xX]\s+/, '').replace(/\s+[×xX]\s+/g, ' ');
  s = s.replace(RANK_MARKER_RE, '');
  // Deliberately NOT lowercased: ott-lookup.js's candidatesFor compares names
  // with `=` under BINARY collation against OTT's Title-Case-genus names, so
  // a lowercased retry can never match (a bare `COLLATE NOCASE` would fix the
  // match but defeats idx_ott_taxa_name and times out). This function's job
  // is to strip authority/hybrid/rank markers, not to change case.
  return s.replace(/\s+/g, ' ').trim();
}

function genusOf(scientificName) {
  return String(scientificName || '').trim().split(/\s+/)[0].toLowerCase();
}

/** @returns {'plantae'|'fungi'|'microbe'|null} */
function curatedKingdomHint(scientificName) {
  const g = genusOf(scientificName);
  if (!g) return null;
  if (FUNGAL_GENERA.has(g) || EXTRA_FUNGAL_GENERA.has(g)) return 'fungi';
  if (BACTERIAL_GENERA.has(g)) return 'microbe';
  if (PLANT_GENERA.has(g)) return 'plantae';
  return null;
}

function isWeak(candidate) {
  const flags = (candidate.flags || '').toLowerCase();
  return WEAK_FLAGS.some(f => flags.includes(f));
}

/**
 * @param {{name: string, candidates: Array<object>, curatedHint: string|null}} input
 * @returns {{accept: boolean, ott_id: number|null, reason: string, candidateIds?: number[]}}
 */
function resolve({ name, candidates, curatedHint }) {
  const all = candidates || [];
  if (all.length === 0) return { accept: false, ott_id: null, reason: 'unmatched' };

  const strong = all.filter(c => !isWeak(c));
  const pool = strong.length > 0 ? strong : all;

  const accept = (c) => {
    if (curatedHint) {
      // If a hint exists, we need to confirm it. A null/undefined kingdom means
      // we can't confirm the hint, so we must abstain rather than guess.
      if (!c.kingdom) {
        return { accept: false, ott_id: null, reason: 'ambiguous',
                 candidateIds: [c.ott_id] };
      }
      if (c.kingdom !== curatedHint) {
        return { accept: false, ott_id: null, reason: 'hint_contradiction',
                 candidateIds: [c.ott_id] };
      }
    }
    return { accept: true, ott_id: c.ott_id, reason: 'resolved_local' };
  };

  if (pool.length === 1) return accept(pool[0]);

  if (curatedHint) {
    // Filter to candidates that match the hint AND have a known kingdom.
    // Null kingdoms cannot confirm the hint, so exclude them.
    const matching = pool.filter(c => c.kingdom && c.kingdom === curatedHint);
    if (matching.length === 1) {
      return { accept: true, ott_id: matching[0].ott_id, reason: 'resolved_local' };
    }
  }

  return { accept: false, ott_id: null, reason: 'ambiguous',
           candidateIds: pool.map(c => c.ott_id) };
}

/**
 * Validate a TNRS-returned taxon against the curated kingdom hint.
 *
 * TNRS context-pinning (see ott-tnrs-fallback.js) is required for recall,
 * but it also means a pinned batch returns a confident id with NO
 * ambiguity signal — pinning "Animals" makes TNRS deterministically hand
 * back the animal homonym for a genus-collision name, with nothing in the
 * response to say so. This is the abstain check for that network path,
 * mirroring what the local multi-candidate pass gets from `resolve()`
 * above: if a curated hint exists and disagrees with the kingdom the
 * returned taxon actually walks up to, treat it as the wrong homonym and
 * abstain rather than writing it.
 *
 * @param {{ottId: number, kingdom: string|null, curatedHint: string|null}} input
 * @returns {{accept: boolean, ott_id: number|null, reason: 'resolved_tnrs'|'hint_contradiction'}}
 */
function validateTnrsMatch({ ottId, kingdom, curatedHint }) {
  if (curatedHint && kingdom !== curatedHint) {
    return { accept: false, ott_id: null, reason: 'hint_contradiction' };
  }
  return { accept: true, ott_id: ottId, reason: 'resolved_tnrs' };
}

/**
 * Reduce an infraspecific name to its genus + species binomial.
 *
 * OTT carries species; this corpus carries subspecies, varieties, trinomials and
 * quoted cultivars ("Gossypium hirsutum 'Deltapine 458 B/rr'"). Those are a
 * GRANULARITY mismatch, not a matching failure — the correct answer is the
 * parent species, because a subspecies belongs to its species. Callers must
 * record such a link distinctly (ott_status='resolved_binomial'), because the
 * link is MANY-TO-ONE: every cultivar and subspecies of a species shares that
 * species' single ott_id, so ott_id stops being an identity key for those rows.
 * The lineage is fine — a cultivar shares its species' ranks exactly.
 *
 * Returns null when there is nothing to reduce or the name is not
 * genus-species shaped — a virus name would truncate to nonsense
 * ("Tomato yellow"), and a Candidatus prefix is a status, not a genus.
 *
 * @param {string} name
 * @returns {string|null}
 */
function binomialOf(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  // Virus/viroid names must never be truncated: the leading tokens are the HOST,
  // so `Helicoverpa armigera nucleopolyhedrovirus` would become the moth the virus
  // kills. Match a token ENDING in the marker rather than the whole word — a
  // \b-anchored word match misses the -virus suffix forms entirely, while a bare
  // substring match would wrongly refuse real taxa whose epithet contains the
  // letters (Hygrophorus parvirussula, Lipaugus virussu, Tristemma virusanum).
  // OTT carries no viruses at all, so these can never resolve here regardless;
  // virus taxonomy is ICTV's, not Open Tree's.
  if (/\b\w*(virus|viroid|phage|satellite)\b/i.test(raw)) return null;

  const t = raw.split(/\s+/);
  if (t.length < 3) return null;                       // already a binomial, or a single taxon
  if (t[0] === 'Candidatus') return null;              // a status prefix, not a genus
  if (!/^[A-Z][a-z-]+$/.test(t[0])) return null;       // genus: capitalised, otherwise lowercase
  if (!/^[a-z-]+$/.test(t[1])) return null;            // species epithet: all lowercase
  return `${t[0]} ${t[1]}`;
}

module.exports = { resolve, normalizeName, curatedKingdomHint, binomialOf, validateTnrsMatch, genusOf, PLANT_GENERA, WEAK_FLAGS };
