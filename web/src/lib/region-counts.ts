/**
 * region-counts — the literature region-count contract for the crop-web rail badge.
 * Pure, zero-dep, client-only. crop-web.astro's `is:inline` script CANNOT import this
 * (inline scripts are emitted verbatim), so it carries a verbatim MIRROR of these two
 * functions. THIS module is the tested source of truth; keep the mirror identical.
 */
export type RegionFilter = { scope: string | null; country: string | null; subdivision: string | null };
export type CountableEdge = {
  subject_id: number;
  object_id: number | null;
  scopes?: string[] | null;
  country?: string | null;
  subdivision?: string | null;
};

export function matchesRegion(edge: CountableEdge, f: RegionFilter): boolean {
  return (!f.scope || (!!edge.scopes && edge.scopes.includes(f.scope)))
    && (!f.country || edge.country === f.country)
    && (!f.subdivision || edge.subdivision === f.subdivision);
}

// Incident-edge count per entity id (both endpoints), over edges passing the filter.
export function litCountsByEntity(edges: CountableEdge[], f: RegionFilter): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of edges) {
    if (!matchesRegion(e, f)) continue;
    m.set(e.subject_id, (m.get(e.subject_id) || 0) + 1);
    if (e.object_id != null) m.set(e.object_id, (m.get(e.object_id) || 0) + 1);
  }
  return m;
}
