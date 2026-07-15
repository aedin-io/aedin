'use strict';
// Pure resolver: a disease/pest common name -> { scientificName, category, kind }.
// Curated, high-frequency only; abstains (null) on anything uncurated so the
// caller stages-but-doesn't-promote rather than guessing an attacker. The
// caller resolves scientificName -> entity id via the existing entity lookup.

// kind 'pathogen' -> disease_resistance; kind 'pest' -> pest_resistance.
// Keys are lowercased; aliases share a target.
const MAP = {
  // ── pathogens (disease_resistance) ──
  'fusarium wilt': { scientificName: 'Fusarium oxysporum', kind: 'pathogen' },
  'fusarium': { scientificName: 'Fusarium oxysporum', kind: 'pathogen' },
  'verticillium wilt': { scientificName: 'Verticillium dahliae', kind: 'pathogen' },
  'verticillium': { scientificName: 'Verticillium dahliae', kind: 'pathogen' },
  'tmv': { scientificName: 'Tobacco mosaic virus', kind: 'pathogen' },
  'tobacco mosaic virus': { scientificName: 'Tobacco mosaic virus', kind: 'pathogen' },
  'tobacco mosaic': { scientificName: 'Tobacco mosaic virus', kind: 'pathogen' },
  'tomv': { scientificName: 'Tomato mosaic virus', kind: 'pathogen' },
  'southern blight': { scientificName: 'Sclerotium rolfsii', kind: 'pathogen' },
  // Early blight is host-qualified (plant-pathologist verdict 2026-06-25): TOMATO
  // early blight's accepted large-spored agent is Alternaria linariae (A. tomatophila
  // is a synonym; Woudenberg 2014 + the corpus EPPO index ALTETP). A. solani is the
  // potato-associated taxon — kept under the potato key + its own binomial.
  'early blight': { scientificName: 'Alternaria linariae', kind: 'pathogen' },
  'alternaria linariae': { scientificName: 'Alternaria linariae', kind: 'pathogen' },
  'alternaria tomatophila': { scientificName: 'Alternaria linariae', kind: 'pathogen' },
  'potato early blight': { scientificName: 'Alternaria solani', kind: 'pathogen' },
  'alternaria solani': { scientificName: 'Alternaria solani', kind: 'pathogen' },
  'late blight': { scientificName: 'Phytophthora infestans', kind: 'pathogen' },
  'bacterial wilt': { scientificName: 'Ralstonia solanacearum', kind: 'pathogen' },
  'tomato spotted wilt': { scientificName: 'Tomato spotted wilt virus', kind: 'pathogen' },
  'tswv': { scientificName: 'Tomato spotted wilt virus', kind: 'pathogen' },
  'gray leaf spot': { scientificName: 'Stemphylium solani', kind: 'pathogen' },
  'root-knot nematode': { scientificName: 'Meloidogyne incognita', kind: 'pathogen' },
  'root knot nematode': { scientificName: 'Meloidogyne incognita', kind: 'pathogen' },
  'nematode': { scientificName: 'Meloidogyne incognita', kind: 'pathogen' },
  // GRIN tomato-disease vocabulary extension (Phase-1 operational run, 2026-06-25):
  // scientific-name surface forms of already-curated pathogens + high-frequency
  // tomato diseases the narratives name that the original map missed.
  'fusarium oxysporum': { scientificName: 'Fusarium oxysporum', kind: 'pathogen' },
  'fusarium oxysporium': { scientificName: 'Fusarium oxysporum', kind: 'pathogen' }, // common misspelling
  'leaf mold': { scientificName: 'Passalora fulva', kind: 'pathogen' },
  'leaf mould': { scientificName: 'Passalora fulva', kind: 'pathogen' },
  'cladosporium fulvum': { scientificName: 'Passalora fulva', kind: 'pathogen' }, // syn. of Passalora fulva
  'cmv': { scientificName: 'Cucumber mosaic virus', kind: 'pathogen' },
  'cucumber mosaic virus': { scientificName: 'Cucumber mosaic virus', kind: 'pathogen' },
  // ── arthropod pests (pest_resistance) ──
  'whitefly': { scientificName: 'Bemisia tabaci', kind: 'pest' },
  'whiteflies': { scientificName: 'Bemisia tabaci', kind: 'pest' },
  'aphid': { scientificName: 'Aphididae', kind: 'pest' },
  'aphids': { scientificName: 'Aphididae', kind: 'pest' },
  'spider mite': { scientificName: 'Tetranychidae', kind: 'pest' },
  'spider mites': { scientificName: 'Tetranychidae', kind: 'pest' },
  'hornworm': { scientificName: 'Manduca', kind: 'pest' },
  'fruitworm': { scientificName: 'Helicoverpa', kind: 'pest' },
};

function build(hit) {
  return {
    scientificName: hit.scientificName,
    category: hit.kind === 'pathogen' ? 'disease_resistance' : 'pest_resistance',
    kind: hit.kind,
  };
}

// Strip qualifiers that wrap an otherwise-curated attacker name so the base
// name can be looked up: a parenthetical synonym/race note "(A. linariae; syn. …)"
// or "(race 2)", a "race N" suffix, and a forma-specialis tail "f. sp. lycopersici"
// / "f. lycopersici". The literal "f." (period required) keeps bare "f"-words
// (e.g. inside "leaf") safe. Fallback only — a direct lookup always wins first.
function normalizeAttacker(key) {
  return key
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bf\.\s*(?:sp\.?\s*)?.*$/, ' ')
    .replace(/\brace\s+\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveAttackerName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (MAP[key]) return build(MAP[key]);
  const norm = normalizeAttacker(key);
  if (norm && norm !== key && MAP[norm]) return build(MAP[norm]);
  return null;
}

module.exports = { resolveAttackerName };
