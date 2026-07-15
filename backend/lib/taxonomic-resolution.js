'use strict';

/**
 * Taxonomic-resolution classifier.
 *
 * Classifies an entity's `scientific_name` into the level of taxonomic
 * precision it actually carries, so consumers can filter on resolution quality
 * and the query layer can roll genus-level evidence up under a species' genus:
 *
 *   'species'    — a binomial (incl. infraspecific var./subsp./forma). The
 *                  claim names a determinate species.
 *   'genus_only' — "Genus sp.", a bare genus, or an explicit (genus) marker.
 *                  Species deliberately left undetermined (see the extractor's
 *                  species-resolution precedence rules 2 & 3).
 *   'collective' — "Genus spp." or any rank above genus (family/order/…),
 *                  whether written as "Coccinellidae (family)" or bare
 *                  "Aphididae"/"Lepidoptera".
 *   null         — empty / unclassifiable input.
 *
 * This is the structural backbone of the "keep the Genus sp. fallback, but make
 * it filterable not noisy" decision (docs/common-name-species-resolution.md).
 * Pure function of the name string — no DB, no taxonomy lookup.
 */

// Rank words that may appear as a parenthetical marker, e.g. "X (family)".
const COLLECTIVE_RANKS = new Set([
  'family', 'superfamily', 'subfamily', 'tribe', 'subtribe',
  'order', 'suborder', 'infraorder', 'superorder',
  'class', 'subclass', 'superclass', 'infraclass',
  'phylum', 'subphylum', 'division', 'subdivision',
  'kingdom', 'subkingdom', 'cohort', 'clade', 'section',
]);

// Connectors that signal an infraspecific (still species-level) name.
const INFRASPECIFIC = new Set(['var.', 'var', 'subsp.', 'subsp', 'ssp.', 'ssp',
  'f.', 'forma', 'cf.', 'cf', 'nr.', 'nr', 'aff.', 'aff']);

// Leading prefixes to strip before counting binomial tokens.
const LEADING_PREFIXES = new Set(['candidatus', 'ca.', '×', 'x']);

// Well-known supra-genus taxon names that carry NO rank-marking suffix the
// heuristic below could catch (kingdoms, phyla, zoological classes, legacy
// family names, informal angiosperm groups). Closed, curated set — these end
// in -a / irregular forms that thousands of genera also use (Salvia, Russula),
// so they can only be recognized by name, not by suffix.
const HIGHER_TAXON_NAMES = new Set([
  // kingdoms / domains / top-level informal groups
  'plantae', 'animalia', 'fungi', 'bacteria', 'archaea', 'protista', 'chromista',
  'viruses', 'viroids', 'angiosperms', 'angiospermae', 'magnoliophyta',
  'gymnosperms', 'gymnospermae', 'dicotyledons', 'monocotyledons',
  // phyla
  'arthropoda', 'mollusca', 'nematoda', 'nemata', 'annelida', 'chordata',
  'platyhelminthes', 'cnidaria', 'tardigrada', 'rotifera',
  // classes
  'insecta', 'arachnida', 'mammalia', 'aves', 'reptilia', 'amphibia',
  'gastropoda', 'bivalvia', 'chilopoda', 'diplopoda', 'malacostraca',
  'collembola', 'symphyla', 'clitellata', 'secernentea',
  // legacy (pre-ICBN) family names without -aceae
  'gramineae', 'compositae', 'leguminosae', 'umbelliferae', 'cruciferae',
  'labiatae', 'palmae', 'guttiferae',
]);

// Suffixes that mark a bare single-token name as above genus.
const HIGHER_RANK_SUFFIXES = [
  /idae$/i,    // animal family
  /inae$/i,    // animal subfamily
  /ini$/i,     // animal tribe
  /oidea$/i,   // animal superfamily
  /aceae$/i,   // plant/fungal family
  /ales$/i,    // plant/fungal order
  /aceae$/i,
  /ptera$/i,   // many insect orders (Lepidoptera, Coleoptera, Diptera, …)
  /phyta$/i,   // plant divisions
  /mycota$/i,  // fungal divisions
  /mycetes$/i, // fungal classes
  /viricetes$/i, /virales$/i, /viridae$/i, // virus higher ranks
];

function classifyTaxonomicResolution(name) {
  if (!name || typeof name !== 'string') return null;
  const norm = name.replace(/\s+/g, ' ').trim();
  if (!norm) return null;

  // 1. Explicit parenthetical rank marker wins.
  const paren = norm.match(/\(([a-z]+)\)/i);
  if (paren) {
    const rank = paren[1].toLowerCase();
    if (rank === 'genus') return 'genus_only';
    if (rank === 'species' || rank === 'subspecies' || rank === 'variety') return 'species';
    if (COLLECTIVE_RANKS.has(rank)) return 'collective';
    // unknown parenthetical rank: fall through to token analysis
  }

  const tokens = norm.split(' ');
  const lower = tokens.map((t) => t.toLowerCase());

  // 2. "spp." anywhere → collective (multiple unspecified species).
  if (lower.some((t) => t === 'spp.' || t === 'spp')) return 'collective';

  // 3. trailing "sp." / "sp" → genus, species undetermined.
  const last = lower[lower.length - 1];
  if (last === 'sp.' || last === 'sp') return 'genus_only';

  // 4. infraspecific connector present → still a determinate species-level name.
  if (lower.some((t) => INFRASPECIFIC.has(t))) return 'species';

  // 5. strip leading prefixes (Candidatus, hybrid ×) then count real tokens.
  const meaningful = tokens.filter((t, i) => !(i === 0 && LEADING_PREFIXES.has(t.toLowerCase())));
  if (meaningful.length >= 2) return 'species';

  // 6. single token: bare genus vs. bare higher rank.
  const solo = meaningful[0] || '';
  if (HIGHER_TAXON_NAMES.has(solo.toLowerCase())) return 'collective';
  if (HIGHER_RANK_SUFFIXES.some((re) => re.test(solo))) return 'collective';
  return 'genus_only';
}

module.exports = { classifyTaxonomicResolution, COLLECTIVE_RANKS };
