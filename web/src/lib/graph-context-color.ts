// contextRole -> node fill. Roles are produced by computeXLayout (x-layout.ts);
// these extend the agroeco bucket palette with antagonist/supporter/disruptor.
export const CONTEXT_COLOR: Record<string, string> = {
  crop: '#22C55E',
  pathogen: '#EC4899',
  pest: '#FB923C',
  pathogen_antagonist: '#14B8A6',
  pest_predator: '#EF4444',
  pest_parasitoid: '#A855F7',
  pollinator: '#3B82F6',
  soil_mutualist: '#6366F1',
  companion_plant: '#65A30D',
  weed: '#A16207',
  defender_supporter: '#84CC16',
  defender_disruptor: '#991B1B',
  neutral: '#94A3B8',
};

export function contextColor(role: string): string {
  return CONTEXT_COLOR[role] ?? CONTEXT_COLOR.neutral;
}
