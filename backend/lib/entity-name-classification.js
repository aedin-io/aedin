'use strict';

// Name-based bio_category / primary_role inference.
//
// Used by load-globi-claims when an entity must be auto-created from a GloBI
// triple and no taxon_path is available. Without this hook, virus-named
// entities are stored as bio_category='other', causing the resolveVariable()
// `pathogenOf` branch to fall through to default `pathogen_pressure` (-2.0)
// instead of correctly routing entomopathogenic viruses to `biocontrol` (+3.0).
//
// Detection scope: viruses, viroids, phages. Bacterial/fungal/animal names
// don't carry reliable kingdom-revealing suffixes, so they remain reliant on
// taxon_path / GBIF lookup (handled elsewhere).

const VIRUS_RE = /(virus(?:es)?|viroid(?:s)?|phage(?:s)?)\b/i;

// Entomopathogenic-virus suffixes — viruses that infect insects, used as
// biocontrol agents in IPM. These are BENEFICIAL in agroecological scope
// (they kill pest insects), not pathogen pressure.
//   - nucleopolyhedrovirus / NPV (Baculoviridae)
//   - granulovirus (Baculoviridae)
//   - iflavirus (Iflaviridae)
//   - dicistrovirus (Dicistroviridae)
//   - nudivirus (Nudiviridae)
//   - cypovirus (Reoviridae)
//   - entomopoxvirus (Poxviridae - subfamily Entomopoxvirinae)
//   - ascovirus (Ascoviridae)
const ENTOMOPATHOGEN_VIRUS_RE = /(nucleopolyhedrovirus|granulovirus|iflavirus|dicistrovirus|nudivirus|cypovirus|entomopoxvirus|ascovirus|baculovirus|densovirus)\b/i;

// Phytopathogenic-virus suffixes / families — viruses that infect plants,
// pathogen pressure on crops. Includes both ICTV taxonomy suffixes AND
// English plant-symptom keyword fragments (per the agroecologist gate
// closeout finding: many phytopath viruses have descriptive English names
// like "leaf roll", "ringspot", "yellows", "stunt" rather than ICTV-suffix
// names).
const PHYTOPATHOGEN_VIRUS_RE = /(mosaic\s+virus|tobamovirus|potyvirus|begomovirus|geminivirus|rhabdovirus|tobravirus|cucumovirus|potexvirus|tospovirus|comovirus|nepovirus|sobemovirus|polerovirus|luteovirus|carlavirus|carmovirus|caulimovirus|tymovirus|necrovirus|tombusvirus|umbravirus|ilarvirus|alfamovirus|cytorhabdovirus|nucleorhabdovirus|varicosavirus|trirhavirus|soymovirus|tritimovirus|fabavirus|badnavirus|chlorosis-associated|ringspot\s+virus|leaf[-\s]curl|leaf[-\s]roll|vein[-\s]clearing|vein[-\s]banding|stunt\s+virus|dwarf\s+virus|necrosis\s+virus|blotch\s+virus|streak\s+virus|mottle\s+virus|yellows?\s+virus)\b/i;

function inferCategoryFromName(name) {
  if (!name || typeof name !== 'string') return null;
  if (!VIRUS_RE.test(name)) return null;

  // Refined virus-role inference (Phase-1.5 follow-up to bug #3): split
  // generic `pathogen_viral` into host-aware roles so the downstream scorer
  // (build-scores.js) can route entomopathogens to the BENEFICIAL set and
  // phytopathogens to the PEST set without re-flattening the sign.
  let primary_role = 'pathogen_viral';  // generic fallback
  if (ENTOMOPATHOGEN_VIRUS_RE.test(name)) {
    primary_role = 'entomopathogen_viral';
  } else if (PHYTOPATHOGEN_VIRUS_RE.test(name)) {
    primary_role = 'phytopathogen_viral';
  }

  return { bio_category: 'microbe', primary_role };
}

module.exports = { inferCategoryFromName, VIRUS_RE, ENTOMOPATHOGEN_VIRUS_RE, PHYTOPATHOGEN_VIRUS_RE };
