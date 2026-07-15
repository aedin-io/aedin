// Pure quadrant ("X") layout for the crop-web interaction graph.
// Horizontal = kingdom (bio_category); vertical = edge valence (interaction_category).
// Never positions by primary_role. See spec 2026-06-27-interaction-graph-x-quadrant-design.md.

export interface XNode { id: string; bio_category?: string; primary_role?: string; }
export interface XEdge { subject_id: string; object_id: string; interaction_category?: string; interaction_count?: number; }
export interface XPlacement {
  side: -1 | 0 | 1; valence: -1 | 0 | 1; ring: 0 | 1 | 2 | 3;
  contextRole: string; parentId: string | null; x: number; y: number;
}

const TOP_CATS = new Set(['mutualism', 'pollination', 'flower_visitor', 'nectar_provision', 'pollen_provision', 'mycorrhizal', 'facilitation']);
const BOTTOM_CATS = new Set(['pathogen_pressure', 'pest_pressure', 'herbivory', 'disease_resistance', 'pest_resistance']);
const POLLINATOR_CATS = new Set(['pollination', 'flower_visitor', 'nectar_provision', 'pollen_provision']);
const SUPPORTER_CATS = new Set(['flower_visitor', 'nectar_provision', 'pollen_provision', 'provides_refuge', 'provides_alternative_prey', 'attracts_natural_enemy']);
const BIOCONTROL_CATS = new Set(['biocontrol', 'predation', 'parasitism']);
const CAT_PRIORITY: Record<string, number> = {
  pathogen_pressure: 5, pest_pressure: 5, herbivory: 5,
  disease_resistance: 4, pest_resistance: 4,
  mycorrhizal: 3, mutualism: 3, facilitation: 3,
  pollination: 2, flower_visitor: 2, nectar_provision: 2, pollen_provision: 2,
};
const prio = (cat?: string) => CAT_PRIORITY[cat ?? ''] ?? 0;

function kingdomSide(n: XNode): -1 | 0 | 1 {
  if (n.primary_role === 'pathogen_nematode') return -1;            // nematode -> microbial/left
  const k = n.bio_category;
  if (k === 'invertebrate' || k === 'vertebrate') return 1;
  if (k === 'plantae') return 0;
  return -1;                                                        // fungi/microbe/other -> left
}
function valenceOf(cat?: string): -1 | 0 | 1 {
  if (cat && TOP_CATS.has(cat)) return 1;
  if (cat && BOTTOM_CATS.has(cat)) return -1;
  return 0;
}
function ring1Role(side: number, valence: number, cat?: string): string {
  if (valence === -1) return side === 1 ? 'pest' : side === 0 ? 'weed' : 'pathogen';
  if (valence === 1) return POLLINATOR_CATS.has(cat ?? '') ? 'pollinator' : side === 0 ? 'companion_plant' : 'soil_mutualist';
  return side === 0 ? 'companion_plant' : 'neutral';
}
const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const a = m.get(k) ?? (m.set(k, []).get(k) as T[]); a.push(v); };

export function computeXLayout(
  { focusId, nodes, edges, expanded }: { focusId: string; nodes: XNode[]; edges: XEdge[]; expanded?: Set<string> },
): Map<string, XPlacement> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const exp = expanded ?? new Set<string>();
  type Sem = { side: -1 | 0 | 1; valence: -1 | 0 | 1; ring: 0 | 1 | 2 | 3; contextRole: string; parentId: string | null };
  const sem = new Map<string, Sem>();
  sem.set(focusId, { side: 0, valence: 0, ring: 0, contextRole: 'crop', parentId: null });

  // Ring 1: gather every crop-incident edge per neighbour, then pick the winning category.
  const cands = new Map<string, { cat?: string; count: number }[]>();
  for (const e of edges) {
    const other = e.subject_id === focusId ? e.object_id : e.object_id === focusId ? e.subject_id : null;
    if (!other || other === focusId || !byId.has(other)) continue;
    push(cands, other, { cat: e.interaction_category, count: e.interaction_count ?? 0 });
  }
  for (const [other, list] of cands) {
    list.sort((a, b) => prio(b.cat) - prio(a.cat) || b.count - a.count);
    const cat = list[0].cat;
    const node = byId.get(other)!;
    const side = kingdomSide(node);
    const valence = valenceOf(cat);
    sem.set(other, { side, valence, ring: 1, contextRole: ring1Role(side, valence, cat), parentId: focusId });
  }

  // Ring 2: biocontrol agents whose TARGET is a ring-1 bottom threat. Agent follows the target's side.
  for (const e of edges) {
    if (e.interaction_category !== 'biocontrol') continue;
    // biocontrol edges are directed agent(subject) -> target(object); ring-2 agent = subject, threat = object.
    const target = sem.get(e.object_id);
    if (!target || target.ring !== 1 || target.valence !== -1) continue;
    const agentId = e.subject_id;
    if (sem.has(agentId)) continue;                                  // ring-1 (direct) wins
    const agent = byId.get(agentId);
    if (!agent) continue;
    const role = target.contextRole === 'pathogen'
      ? 'pathogen_antagonist'
      : /parasitoid/.test(agent.primary_role ?? '') ? 'pest_parasitoid' : 'pest_predator';
    sem.set(agentId, { side: target.side, valence: -1, ring: 2, contextRole: role, parentId: e.object_id });
  }

  // Ring 3 (only for expanded defenders): supporters (lime) + disruptors (maroon).
  for (const e of edges) {
    const cat = e.interaction_category ?? '';
    if (SUPPORTER_CATS.has(cat)) {
      for (const [defId, otherId] of [[e.subject_id, e.object_id], [e.object_id, e.subject_id]] as const) {
        const def = sem.get(defId);
        if (def?.ring === 2 && exp.has(defId) && !sem.has(otherId) && otherId !== focusId && byId.has(otherId)) {
          sem.set(otherId, { side: def.side, valence: -1, ring: 3, contextRole: 'defender_supporter', parentId: defId });
        }
      }
    }
    if (BIOCONTROL_CATS.has(cat)) {
      const def = sem.get(e.object_id);
      if (def?.ring === 2 && exp.has(e.object_id) && !sem.has(e.subject_id) && e.subject_id !== focusId && byId.has(e.subject_id)) {
        sem.set(e.subject_id, { side: def.side, valence: -1, ring: 3, contextRole: 'defender_disruptor', parentId: e.object_id });
      }
    }
  }

  // Positions: x by side*ring; y by valence, vertically stacked within each (side,valence) group.
  const RING_X = [0, 200, 360, 520];
  const ROW_Y = 150;
  const GAP = 70;
  const groups = new Map<string, string[]>();
  for (const [id, p] of sem) { if (p.ring !== 0) push(groups, `${p.side}|${p.valence}`, id); }
  const out = new Map<string, XPlacement>();
  const c = sem.get(focusId)!;
  out.set(focusId, { ...c, x: 0, y: 0 });
  for (const [, ids] of groups) {
    ids.sort((a, b) => sem.get(a)!.ring - sem.get(b)!.ring || (a < b ? -1 : 1));
    const n = ids.length;
    ids.forEach((id, i) => {
      const p = sem.get(id)!;
      out.set(id, { ...p, x: p.side * RING_X[p.ring], y: p.valence * ROW_Y + (i - (n - 1) / 2) * GAP });
    });
  }
  return out;
}
