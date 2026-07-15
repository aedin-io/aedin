// Loose sibling grouping (Phase A): claims from the same source + interaction +
// effect + direction, relative to the entity being viewed, form one soft list.
// Rebuilt from partner ENTITIES (clean, linkable), never by parsing the lossy quote.
export type SiblingRow = {
  sourceId: number | null;
  category: string | null;
  effectDirection: string | null;
  direction: 'out' | 'in';
  partnerName: string | null;
  partnerSlug: string | null;
  partnerCommon?: string | null;
};

export function siblingGroupKey(r: SiblingRow): string {
  return [r.sourceId ?? '∅', r.category ?? '∅', r.effectDirection ?? '∅', r.direction].join('|');
}

// One-pass O(n) grouping for a whole row set: groupKey -> deduped display members.
// Single source of truth for the entity-page frontmatter enrichment.
export function siblingMembersByGroup(rows: SiblingRow[]): Map<string, { name: string; slug: string | null }[]> {
  const map = new Map<string, { name: string; slug: string | null }[]>();
  for (const r of rows) {
    const name = r.partnerCommon || r.partnerName;
    if (!name) continue;
    const key = siblingGroupKey(r);
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    const dedup = (r.partnerSlug || name).toLowerCase();
    if (!arr.some(m => (m.slug || m.name).toLowerCase() === dedup)) arr.push({ name, slug: r.partnerSlug });
  }
  return map;
}

// A quote is "list-shaped" if it has the table-splice ellipsis, a list connector,
// or three-or-more comma-separated items. Legacy heuristic; new data will carry
// source_structure (Phase B / Track 2) instead.
const LIST_SHAPE = /…|\b(?:include|includes|including|such as)\b|(?:,[^,]+){2,}/i;
export function isListShapedQuote(q: string | null): boolean {
  return !!q && LIST_SHAPE.test(q);
}
