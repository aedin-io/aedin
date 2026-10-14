// Academic verification for the half-price academic plans.
// A user counts as academic if they linked an ORCID iD, or their verified
// email is on an academic domain (covers Microsoft school accounts too).

// Academic second-level labels used under country-code TLDs: ac.uk, edu.au, ...
const ACADEMIC_SLD = new Set(['ac', 'edu']);

// Institutions whose domains don't follow the .edu / .ac.* pattern. Extend as needed.
export const EXTRA_ACADEMIC_DOMAINS = new Set<string>([
  'cgiar.org',
  'cirad.fr',
  'inrae.fr',
  'wur.nl',
  'ethz.ch',
  'epfl.ch',
  'csiro.au',
]);

export function isAcademicEmail(email: string | null | undefined): boolean {
  const domain = (email ?? '').toLowerCase().trim().split('@')[1];
  if (!domain || !domain.includes('.')) return false;
  const labels = domain.split('.');
  const tld = labels[labels.length - 1];
  if (tld === 'edu') return true;
  if (labels.length >= 3 && ACADEMIC_SLD.has(labels[labels.length - 2])) return true;
  for (let i = 0; i < labels.length - 1; i++) {
    if (EXTRA_ACADEMIC_DOMAINS.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
