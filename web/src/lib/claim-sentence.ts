// Composes a human-readable sentence from a claim's structured fields, so the UI
// never depends on the (essentially-empty) extracted_claim column. Verbs are
// editorial; extend the map as new interaction_category values appear.
const CATEGORY_VERB: Record<string, string> = {
  pest_pressure: 'is a pest of',
  pathogen_pressure: 'is a pathogen of',
  herbivory: 'feeds on',
  predation: 'preys on',
  parasitism: 'parasitizes',
  parasitoid: 'parasitizes',
  mutualism: 'has a mutualistic relationship with',
  pollination: 'pollinates',
  competition: 'competes with',
  biocontrol: 'is a biocontrol agent against',
  attractant: 'attracts',
  nitrogen_fixation: 'fixes nitrogen for',
  mycorrhizal: 'forms mycorrhizae with',
  disease_resistance: 'is resistant to',
  pest_resistance: 'is resistant to',
  disease_vector: 'is a disease vector for',
};

export function composeClaimSentence(
  category: string | null,
  subjectName: string | null,
  objectName: string | null,
): string {
  const subj = subjectName || 'This organism';
  const verb = (category && CATEGORY_VERB[category]) || (category ? category.replace(/_/g, ' ') : 'interacts with');
  if (!objectName) return `${subj} — ${verb}`;
  return `${subj} ${verb} ${objectName}`;
}
