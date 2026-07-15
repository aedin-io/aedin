'use strict';

/**
 * binomial-glossary.js — extract the species binomials a document names, so the
 * extractor can resolve common names to the DOCUMENT's species rather than
 * guessing from prior knowledge (docs/common-name-species-resolution.md,
 * Follow-up B).
 *
 * The cross-chunk problem: a paper names "Bactrocera cucurbitae" once in the
 * abstract, then says "melon fly" for the rest. With 80K-char chunking, the
 * binomial may be in a different chunk than the claim. A document-level
 * glossary, injected into EVERY chunk's prompt, closes that gap.
 *
 * Precision over recall: a wrong binomial in the glossary could mislead the
 * extractor, so a candidate is kept only if it is EITHER (a) already a known
 * entity in our taxonomy, OR (b) appears ≥2× in the document — and never if its
 * genus token is a common English sentence-starter.
 */

// Capitalized English words that can appear at sentence start followed by a
// lowercase word, producing false "Genus species" matches (e.g. "The species",
// "Figure shows", "This insect"). Genus position only.
const GENUS_STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'A', 'An', 'And', 'But', 'Or', 'Nor',
  'In', 'On', 'At', 'For', 'To', 'From', 'With', 'As', 'By', 'Of', 'It', 'We',
  'They', 'Our', 'Their', 'Its', 'His', 'Her', 'Both', 'Each', 'All', 'Some',
  'Many', 'Most', 'Few', 'No', 'Not', 'When', 'Where', 'While', 'Although',
  'However', 'Thus', 'Therefore', 'Here', 'There', 'Fig', 'Figure', 'Table',
  'Section', 'Chapter', 'Plate', 'Box', 'Note', 'Since', 'Because', 'After',
  'Before', 'During', 'Under', 'Over', 'Between', 'Among', 'Within', 'Without',
  'About', 'Above', 'Below', 'Such', 'Other', 'Another', 'Several', 'Various',
  'Total', 'Mean', 'Data', 'Results', 'Methods', 'If', 'Then',
  // Life-stage / morphology words that precede a lowercase word in pest docs
  'Adult', 'Adults', 'Larva', 'Larvae', 'Larval', 'Egg', 'Eggs', 'Pupa',
  'Pupae', 'Nymph', 'Nymphs', 'Male', 'Males', 'Female', 'Females', 'Young',
  // Position / ordinal / document-furniture words
  'Last', 'First', 'Next', 'New', 'Old', 'Top', 'Left', 'Right', 'Front',
  'Back', 'Page', 'Use', 'Used', 'See', 'Add', 'Per', 'Via', 'One', 'Two',
  'Three', 'Four', 'Five', 'High', 'Low', 'Late', 'Early', 'More', 'Less',
  'Once', 'Only', 'Also', 'Even', 'Just', 'Very', 'Often', 'Usually',
  // Agronomy nouns frequently capitalized at sentence/heading start
  'Host', 'Hosts', 'Field', 'Fields', 'Leaf', 'Leaves', 'Root', 'Roots',
  'Stem', 'Stems', 'Seed', 'Seeds', 'Fruit', 'Fruits', 'Plant', 'Plants',
  'Crop', 'Crops', 'Pest', 'Pests', 'Natural', 'Soil', 'Water', 'Damage',
  'Control', 'Management', 'Symptoms', 'Treatment', 'Disease', 'Diseases',
  'Insect', 'Insects', 'Larvae', 'Species', 'Genus', 'Family', 'Order',
]);

// Common lowercase words that are NOT Latin species epithets but often follow a
// capitalized word (excludes "Crop species", "Plant growth", etc.).
const EPITHET_STOPWORDS = new Set([
  'species', 'spp', 'sp', 'genus', 'family', 'order', 'class', 'plants',
  'plant', 'crop', 'crops', 'growth', 'control', 'disease', 'diseases',
  'pest', 'pests', 'insect', 'insects', 'larvae', 'larva', 'adults', 'adult',
  'and', 'the', 'was', 'were', 'are', 'is', 'has', 'had', 'may', 'can',
  'such', 'showed', 'shows', 'found', 'used', 'using', 'based', 'during',
  'after', 'before', 'between', 'within', 'also', 'these', 'this', 'that',
  // English common-name component nouns that masquerade as a species epithet
  // in "Genus commonword" false binomials (e.g. "Citrus leafminer").
  'leafminer', 'leafminers', 'armyworm', 'borer', 'borers', 'looper', 'loopers',
  'caterpillar', 'caterpillars', 'cockroach', 'beetle', 'beetles', 'moth',
  'moths', 'fly', 'flies', 'wasp', 'wasps', 'bug', 'bugs', 'mite', 'mites',
  'aphid', 'aphids', 'weevil', 'weevils', 'midge', 'midges', 'scale', 'scales',
  'thrips', 'whitefly', 'whiteflies', 'mealybug', 'mealybugs', 'hopper',
  'hoppers', 'worm', 'worms', 'maggot', 'maggots', 'grub', 'grubs', 'nematode',
  'nematodes', 'snail', 'snails', 'slug', 'slugs', 'leafhopper', 'planthopper',
  'psyllid', 'sawfly', 'leafroller', 'webworm', 'cutworm', 'budworm', 'bollworm',
  'earworm', 'fruitfly', 'blight', 'rot', 'rust', 'smut', 'wilt', 'mildew', 'mold',
]);

// Genus species (+ optional infraspecific). Genus Capitalized, epithet lowercase.
const BINOMIAL_RE = /\b([A-Z][a-z]{2,})\s+([a-z]{3,})(\s+(?:var|subsp|ssp|f)\.?\s+[a-z]{3,})?\b/g;

/**
 * Extract candidate binomials from full document text with occurrence counts.
 * @returns {Map<string, number>} binomial → count
 */
function extractCandidates(fullText) {
  const counts = new Map();
  if (!fullText || typeof fullText !== 'string') return counts;
  let m;
  BINOMIAL_RE.lastIndex = 0;
  while ((m = BINOMIAL_RE.exec(fullText)) !== null) {
    const genus = m[1];
    const epithet = m[2];
    if (GENUS_STOPWORDS.has(genus)) continue;
    if (EPITHET_STOPWORDS.has(epithet)) continue;
    // Reconstruct the canonical binomial (drop infraspecific marker normalization
    // is left to the entity layer; keep the bare "Genus species" as the key).
    const binomial = `${genus} ${epithet}`;
    counts.set(binomial, (counts.get(binomial) || 0) + 1);
  }
  return counts;
}

// Appositive patterns where a document explicitly links a common name to a
// binomial — the document's OWN disambiguation table. Two orderings:
//   "common name (Genus species)"   e.g. "melon fly (Bactrocera cucurbitae)"
//   "Genus species (common name)"   e.g. "Bactrocera cucurbitae (melon fly)"
const COMMON_THEN_BINOMIAL = /([A-Za-z][A-Za-z'’\- ]{2,44}?)\s*\(\s*([A-Z][a-z]{2,}\s+[a-z]{3,})\s*\)/g;
const BINOMIAL_THEN_COMMON = /\b([A-Z][a-z]{2,}\s+[a-z]{3,})\s*\(\s*([A-Za-z][^)]{2,44})\)/g;

// A parenthetical is a taxonomic AUTHORITY (not a common name) if it's a
// capitalized surname, an "Author, year", a bare initial like "L.", or carries
// a 4-digit year. Common names are lowercase phrases ("melon fly").
function looksLikeAuthority(s) {
  const t = s.trim();
  if (/\d{4}/.test(t)) return true;                       // contains a year
  if (/^[A-Z]\.?$/.test(t)) return true;                  // "L." / "L"
  if (/^[A-Z][a-zé]+\.?$/.test(t)) return true;           // single capitalized surname "Walker", "Fabricius"
  if (/^[A-Z][a-zé]+,/.test(t)) return true;              // "Author, ..."
  if (/^\(?[A-Z][a-zé]+\)?\s*&/.test(t)) return true;     // "Smith & Jones"
  return false;
}

// Words that are never the start of a real common name — articles, conjunctions,
// verbs, and connective fragments that PDF appositive-capture drags in.
const CN_LEADING_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'is', 'was', 'are', 'were', 'be', 'been',
  'this', 'these', 'those', 'that', 'which', 'its', 'their', 'our', 'his', 'her',
  'also', 'as', 'by', 'with', 'to', 'from', 'in', 'on', 'at', 'for', 'include',
  'includes', 'including', 'such', 'called', 'named', 'known', 'it', 'they',
  'adult', 'adults', 'larva', 'larvae', 'host', 'hosts', 'plants', 'plant',
  'tiny', 'small', 'large', 'common', 'major', 'important', 'native', 'introduced',
]);

// Trim a captured common-name phrase to a clean trailing 1–3-word common name.
// Returns '' (rejected) when the result is empty, too long, or a fragment that
// still contains a conjunction (two names joined, e.g. "rice and corn").
function trimCommonName(phrase) {
  let words = phrase
    .toLowerCase()
    .replace(/[^a-z'’\- ]+/g, ' ')   // drop punctuation/digits
    .split(/\s+/)
    .filter(Boolean);
  // strip leading stopwords
  while (words.length && CN_LEADING_STOP.has(words[0])) words.shift();
  // common names are short; keep the trailing ≤3 meaningful words
  if (words.length > 3) words = words.slice(-3);
  while (words.length && CN_LEADING_STOP.has(words[0])) words.shift();
  if (words.length === 0) return '';
  if (words.includes('and') || words.includes('or')) return ''; // joined names — ambiguous capture
  return words.join(' ').trim();
}

function normalizeBinomial(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Extract the document's explicit (common_name → binomial) appositive pairs.
 * These let the extractor map a bare common name in a claim to the SPECIFIC
 * congener the document tied it to, instead of guessing among same-genus species.
 * @returns {Map<string, Set<string>>} common_name(lower) → set of binomials
 */
function extractPairings(fullText) {
  const pairs = new Map();
  if (!fullText || typeof fullText !== 'string') return pairs;
  const add = (cn, binomialRaw) => {
    const binomial = normalizeBinomial(binomialRaw);  // collapse PDF newlines/double-spaces
    const [genus, epithet] = binomial.split(' ');
    if (GENUS_STOPWORDS.has(genus) || EPITHET_STOPWORDS.has(epithet)) return;
    const name = trimCommonName(cn);
    if (!name || name.length < 3) return;
    if (!pairs.has(name)) pairs.set(name, new Set());
    pairs.get(name).add(binomial);
  };
  let m;
  COMMON_THEN_BINOMIAL.lastIndex = 0;
  while ((m = COMMON_THEN_BINOMIAL.exec(fullText)) !== null) add(m[1], m[2]);
  BINOMIAL_THEN_COMMON.lastIndex = 0;
  while ((m = BINOMIAL_THEN_COMMON.exec(fullText)) !== null) {
    if (looksLikeAuthority(m[2])) continue;
    add(m[2], m[1]);
  }
  return pairs;
}

/**
 * Build a document glossary. Cross-checks candidates against the entities table
 * (known taxonomy) for precision; keeps unknown candidates only if they recur.
 *
 * @param {string} fullText  the FULL document text (not a single chunk)
 * @param {object} db        optional sqlite handle; if provided, entity-match
 *                           promotes single-occurrence candidates
 * @param {object} [opts]    { maxEntries=120 }
 * @returns {Promise<Array<{binomial, count, known}>>}
 */
async function buildGlossary(fullText, db, opts = {}) {
  const maxEntries = opts.maxEntries || 120;
  const counts = extractCandidates(fullText);
  if (counts.size === 0) return [];

  // Cross-check against entities (batched IN query) when a db is available.
  const known = new Set();
  if (db) {
    const all = [...counts.keys()];
    const CHUNK = 400;
    for (let i = 0; i < all.length; i += CHUNK) {
      const slice = all.slice(i, i + CHUNK);
      const ph = slice.map(() => '?').join(',');
      const rows = await db.all(
        `SELECT scientific_name FROM entities WHERE scientific_name IN (${ph}) COLLATE NOCASE`,
        slice
      );
      for (const r of rows) known.add(r.scientific_name.toLowerCase());
    }
  }

  const kept = [];
  for (const [binomial, count] of counts) {
    const isKnown = known.has(binomial.toLowerCase());
    // Keep if known to our taxonomy OR it recurs (≥2×). Single-occurrence
    // unknown candidates are likely regex noise.
    if (isKnown || count >= 2) {
      kept.push({ binomial, count, known: isKnown });
    }
  }
  // Sort: known first, then by frequency.
  kept.sort((a, b) => (b.known - a.known) || (b.count - a.count) || a.binomial.localeCompare(b.binomial));
  return kept.slice(0, maxEntries);
}

/**
 * Render the glossary as a compact markdown block for prompt injection.
 * @param {Array} glossary  output of buildGlossary()
 * @param {Map<string,Set<string>>} [pairings] output of extractPairings() — the
 *        document's explicit common-name→binomial appositives (disambiguation table)
 */
function renderGlossaryMarkdown(glossary, pairings) {
  const hasBinomials = glossary && glossary.length > 0;
  const hasPairings = pairings && pairings.size > 0;
  if (!hasBinomials && !hasPairings) {
    return '(No explicit binomials detected in this document. Resolve species per the precedence rules; prefer genus-level when unsure.)';
  }
  const lines = [];

  if (hasPairings) {
    // Precision gate: when we have an entity-cross-checked glossary, only surface
    // pairings whose binomial is in it (drops typo'd / non-taxon parentheticals).
    // With no glossary (unit tests / novel-only docs), show all pairings.
    const knownSet = hasBinomials ? new Set(glossary.map(g => g.binomial.toLowerCase())) : null;
    const rendered = [];
    for (const [cn, set] of [...pairings.entries()].sort()) {
      const arr = knownSet ? [...set].filter(b => knownSet.has(b.toLowerCase())) : [...set];
      if (arr.length === 0) continue;
      const flag = arr.length > 1 ? '  ⚠ AMBIGUOUS — multiple species; resolve by context or use genus level' : '';
      rendered.push(`- "${cn}" → ${arr.join(' | ')}${flag}`);
    }
    if (rendered.length) {
      lines.push(
        'COMMON-NAME → SPECIES MAP (the document\'s OWN definitions — highest authority).',
        'When a claim uses one of these common names, use the paired binomial. If a',
        'common name maps to MORE THAN ONE species below, the document does not',
        'disambiguate it — use the genus level (`Genus sp.`) unless the claim\'s local',
        'context names the specific species. Do NOT pick one congener arbitrarily.',
        '',
        ...rendered,
        '',
      );
    }
  }

  if (hasBinomials) {
    lines.push(
      'ALL BINOMIALS IN THIS DOCUMENT (authoritative over your prior knowledge —',
      'never substitute a different congener for one of these):',
      '',
    );
    for (const g of glossary) {
      lines.push(`- ${g.binomial}${g.known ? '' : ' (novel)'}`);
    }
  }
  return lines.join('\n');
}

module.exports = { extractCandidates, extractPairings, buildGlossary, renderGlossaryMarkdown };
