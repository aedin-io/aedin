'use strict';

// Detects virus entities that are clearly wildlife/vertebrate pathogens with
// no agroecological relevance. Used by backfill-vertebrate-virus-scope.js to
// flag out-of-scope entities so agroecological queries can filter them out.
//
// Surfaced by Phase-1.5 follow-up on Bug #3 (agroecologist gate finding):
// "Bat MERS-like coronavirus" was being indexed as a generic pathogen_viral.
// Vertebrate viruses are bycatch from GloBI's broad ingest scope.
//
// IMPORTANT scope decisions:
//   - We DO NOT flag avian/bovine/porcine/etc. viruses with agricultural
//     relevance (poultry/livestock disease) — those belong to animal husbandry
//     even if outside crop-agroecology core.
//   - We flag mammalian wildlife viruses (Bat, Whale, Murine, Macaque, etc.)
//     and human-only viruses (SARS, MERS, Ebola, Lassa, Hantavirus).
//   - Vertebrate-only virus families (filovirus, hantavirus, arenavirus,
//     lentivirus, mammarenavirus) are flagged regardless of host name.

const WILDLIFE_HOST_PATTERNS = [
  /\bBat\b/i, /\bbat\s/i,
  /\bWhale\b/i, /\bDolphin\b/i, /\bPorpoise\b/i,
  /\bMurine\b/i, /\bMouse\b/i, /\bRat\b(?!t)/i,  // "Rat" but not "Ratt..."
  /\bHamster\b/i, /\bGerbil\b/i, /\bRodent\b/i, /\bShrew\b/i, /\bVole\b/i,
  /\bMacaque\b/i, /\bMarmoset\b/i, /\bBaboon\b/i, /\bChimpanzee\b/i,
  /\bSimian\b/i, /\bPrimate\b/i, /\bMonkey\b/i,
  /\bHuman\b/i,  // human-only viruses
  /\bRhinolophus\b/i, /\bMyotis\b/i, /\bPipistrellus\b/i,
  /\bMiniopterus\b/i, /\bChaerephon\b/i, /\bRousettus\b/i, /\bTylonycteris\b/i,
];

const VERTEBRATE_VIRUS_FAMILY_PATTERNS = [
  /coronavirus/i,            // mostly mammalian/avian; some agricultural (avian) but most are wildlife
  /filovirus/i, /ebolavirus/i, /marburgvirus/i,
  /hantavirus/i, /orthohantavirus/i, /puumala/i,
  /arenavirus/i, /mammarenavirus/i, /lassa/i,
  /lentivirus/i, /retrovirus/i,  // includes HIV
  /henipavirus/i,
  /\bSARS\b/i, /\bMERS\b/i,  // pandemic-relevant respiratory
  /\brabies\b/i, /lyssavirus/i,
  /hepatitis/i,
];

function isWildlifeVertebrateVirus(name) {
  if (!name || typeof name !== 'string') return false;
  // Must contain virus-shaped suffix to even qualify (skip random matches)
  if (!/(virus(?:es)?|viroid(?:s)?|phage(?:s)?)\b/i.test(name)) return false;
  // Wildlife host indicator OR vertebrate-only virus family
  return WILDLIFE_HOST_PATTERNS.some(re => re.test(name))
      || VERTEBRATE_VIRUS_FAMILY_PATTERNS.some(re => re.test(name));
}

module.exports = { isWildlifeVertebrateVirus, WILDLIFE_HOST_PATTERNS, VERTEBRATE_VIRUS_FAMILY_PATTERNS };
