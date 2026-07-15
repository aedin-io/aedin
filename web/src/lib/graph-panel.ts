export interface PanelNode { id: string; label: string; commonName?: string; slug?: string; contextRole?: string; bioCategory?: string; primaryRole?: string; }
export interface NeighborGroup { relation: string; items: { id: string; label: string }[]; }
interface PanelEdge { subject_id: string; object_id: string; interaction_category?: string }

// Human-readable relation label from the focus node's point of view.
const RELATION: Record<string, { in: string; out: string }> = {
  pathogen_pressure: { in: 'attacked by', out: 'attacks' },
  pest_pressure: { in: 'eaten by', out: 'eats' },
  herbivory: { in: 'eaten by', out: 'eats' },
  biocontrol: { in: 'controlled by', out: 'controls' },
  pollination: { in: 'pollinated by', out: 'pollinates' },
  flower_visitor: { in: 'flower-visited by', out: 'visits' },
  mutualism: { in: 'partners with', out: 'partners with' },
  mycorrhizal: { in: 'partners with', out: 'partners with' },
  disease_resistance: { in: 'resists', out: 'resists' },
  pest_resistance: { in: 'resists', out: 'resists' },
  disease_vector: { in: 'vectored by', out: 'vectors' },
};
function label(cat: string | undefined, focusIsObject: boolean): string {
  const r = RELATION[cat ?? ''];
  if (!r) return 'related to';
  return focusIsObject ? r.in : r.out;
}

export function groupNeighbors(focusId: string, nodes: PanelNode[], edges: PanelEdge[]): NeighborGroup[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const buckets = new Map<string, { id: string; label: string }[]>();
  for (const e of edges) {
    const focusIsObject = e.object_id === focusId;
    const focusIsSubject = e.subject_id === focusId;
    if (!focusIsObject && !focusIsSubject) continue;
    const otherId = focusIsObject ? e.subject_id : e.object_id;
    const other = byId.get(otherId);
    if (!other) continue;
    const rel = label(e.interaction_category, focusIsObject);
    const arr = buckets.get(rel) ?? (buckets.set(rel, []).get(rel) as { id: string; label: string }[]);
    if (!arr.some(x => x.id === otherId)) arr.push({ id: otherId, label: other.label });
  }
  return [...buckets.entries()].map(([relation, items]) => ({ relation, items }));
}

// DOM renderer (verified manually — see Task 6 checklist).
export function mountSelectionPanel(
  rootEl: HTMLElement,
  hooks: { getNode(id: string): PanelNode | undefined; getNeighbors(id: string): NeighborGroup[]; onSelect(id: string): void; onExpand?(id: string): void; canExpand?(id: string): boolean },
): { select(id: string): void; clear(): void } {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  function clear() { rootEl.innerHTML = '<p class="text-[12px] text-earth-700 italic p-3">Click a node to inspect it.</p>'; }
  function select(id: string) {
    const n = hooks.getNode(id);
    if (!n) { clear(); return; }
    const groups = hooks.getNeighbors(id);
    const expandBtn = hooks.canExpand?.(id)
      ? `<button data-x-expand="${esc(id)}" class="mt-2 px-2 py-1 text-[11px] rounded bg-nature-50 text-nature-900 border border-nature-700/30">⊕ expand ring 3</button>` : '';
    rootEl.innerHTML = `
      <div class="p-3 space-y-2">
        <div class="text-sm font-semibold text-nature-900 italic">${esc(n.label)}</div>
        ${n.commonName ? `<div class="text-[12px] text-earth-700">${esc(n.commonName)}</div>` : ''}
        <div class="text-[10px] font-mono text-earth-700">${esc(n.contextRole ?? n.primaryRole ?? '')}${n.bioCategory ? ` · ${esc(n.bioCategory)}` : ''}</div>
        ${groups.map(g => `
          <div class="mt-2">
            <div class="text-[10px] uppercase tracking-wide text-earth-700">${esc(g.relation)}</div>
            <div class="flex flex-wrap gap-1 mt-1">
              ${g.items.map(it => `<button data-x-chip="${esc(it.id)}" class="text-[11px] px-2 py-0.5 rounded bg-nature-50 border border-nature-700/20 text-nature-900">${esc(it.label)}</button>`).join('')}
            </div>
          </div>`).join('')}
        ${expandBtn}
        ${n.slug ? `<a href="/entity/${esc(n.slug)}" class="block mt-2 text-[12px] text-nature-700 underline">View entity page →</a>` : ''}
      </div>`;
    rootEl.querySelectorAll('[data-x-chip]').forEach(b => b.addEventListener('click', () => hooks.onSelect((b as HTMLElement).dataset.xChip!)));
    rootEl.querySelectorAll('[data-x-expand]').forEach(b => b.addEventListener('click', () => hooks.onExpand?.((b as HTMLElement).dataset.xExpand!)));
  }
  clear();
  return { select, clear };
}
