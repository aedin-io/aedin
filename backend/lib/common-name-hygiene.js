'use strict';

// Common-name hygiene detection for `entities.common_name`.
//
// Three issue types we currently detect:
//   - lazy_self                  → common_name === scientific_name (155 rows in current DB).
//                                   Auto-fix to NULL.
//   - known_canonical_override   → scientific_name has a hand-curated canonical
//                                   common name AND the current value matches
//                                   one of the wrong_patterns. Auto-fix to canonical.
//   - multi_name                 → common_name contains " / " separator (72 rows).
//                                   Flag only — can't auto-pick the right alias.
//
// detectCommonNameIssue(entity) → null if clean, otherwise:
//   { type, suggestion, auto_fixable, current }
//
// Per CLAUDE.md bug #5: the canonical case is `Apis mellifera` mislabeled as
// "Africanized honey bee" — Africanized is a subspecies-level hybrid, not a
// synonym for the species. Michener's *Bees of the World* (2007) calls
// A. mellifera the "common honey bee"; we use "honey bee" as the canonical
// label (no regional/breed qualifier).

const KNOWN_CANONICALS = [
  {
    // The CANONICAL Apis mellifera entity gets "western honey bee" (the
    // ITIS / IUCN-aligned vernacular that disambiguates from A. cerana, A.
    // dorsata, etc.). This was the agroecologist gate's recommendation for
    // an academic / bot-facing knowledge base.
    scientific_name: 'Apis mellifera',
    canonical: 'western honey bee',
    wrong_patterns: [
      /africaniz/i,
      /^honey bee$/i,            // bare "honey bee" lacks species-level disambiguation
      /^european honey bee$/i,
      /^african honey bee$/i,
    ],
    note: 'ITIS / IUCN canonical: "western honey bee". Disambiguates from A. cerana / A. dorsata / A. florea. Africanized = subspecies hybrid (A. m. scutellata × European subspecies).',
  },
];

function _matchesCanonical(k, sciLower) {
  if (k.scientific_name.toLowerCase() === sciLower) return true;
  if (Array.isArray(k.scientific_aliases) && k.scientific_aliases.some(a => a.toLowerCase() === sciLower)) return true;
  return false;
}

function detectCommonNameIssue(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const sci = (entity.scientific_name || '').trim();
  const cn = (entity.common_name || '').trim();
  if (!sci) return null;
  const sciLower = sci.toLowerCase();

  // Issue 1: lazy_self — common_name is just the scientific name (case-insensitive)
  if (cn && cn.toLowerCase() === sciLower) {
    return { type: 'lazy_self', suggestion: null, auto_fixable: true, current: cn };
  }

  // Issue 2: known_canonical_override — hand-curated correction
  if (cn) {
    for (const k of KNOWN_CANONICALS) {
      if (_matchesCanonical(k, sciLower)) {
        if (cn.toLowerCase() === k.canonical.toLowerCase()) return null;  // already correct
        if (k.wrong_patterns.some(re => re.test(cn))) {
          return { type: 'known_canonical_override', suggestion: k.canonical, auto_fixable: true, current: cn };
        }
      }
    }
  }

  // Issue 3: multi_name — slash-delimited aliases (flag only)
  if (cn && cn.includes(' / ')) {
    return { type: 'multi_name', suggestion: null, auto_fixable: false, current: cn };
  }

  return null;
}

module.exports = { detectCommonNameIssue, KNOWN_CANONICALS };
