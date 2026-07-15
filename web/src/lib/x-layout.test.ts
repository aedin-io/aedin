import { describe, it, expect } from 'vitest';
import { computeXLayout, XNode, XEdge } from './x-layout';

// A verified tomato web + cross-kingdom + ring-3 fixtures.
const nodes: XNode[] = [
  { id: 't',   bio_category: 'plantae',      primary_role: 'crop' },
  { id: 'scl', bio_category: 'fungi',        primary_role: 'pathogen_fungal' },   // pathogen (left)
  { id: 'aph', bio_category: 'invertebrate', primary_role: 'pest_insect' },       // pest (right)
  { id: 'myc', bio_category: 'fungi',        primary_role: 'soil_microbe' },      // mutualist (top-left)
  { id: 'bee', bio_category: 'invertebrate', primary_role: 'pollinator' },        // pollinator (top-right)
  { id: 'con', bio_category: 'fungi',        primary_role: 'pathogen_fungal' },   // antagonist of scl (ring2 left)
  { id: 'lady',bio_category: 'invertebrate', primary_role: 'beneficial_predator'},// predator of aph (ring2 right)
  { id: 'nem', bio_category: 'invertebrate', primary_role: 'pathogen_nematode' }, // nematode override -> left
  { id: 'ven', bio_category: 'fungi',        primary_role: 'pathogen_fungal' },   // pathogen (left)
  { id: 'lum', bio_category: 'invertebrate', primary_role: 'pest_insect' },       // earthworm controlling ven (cross-kingdom)
  { id: 'wasp',bio_category: 'invertebrate', primary_role: 'beneficial_parasitoid'}, // parasitoid of aph (ring2 right)
  { id: 'aly', bio_category: 'plantae' },                                          // supporter of wasp (ring3)
  { id: 'hyp', bio_category: 'invertebrate', primary_role: 'pest_insect' },       // hyperparasitoid of wasp (ring3)
  { id: 'moth',bio_category: 'invertebrate' },                                     // tie-break: pollinates AND eats
  { id: 'wd',  bio_category: 'invertebrate' },                                     // uncategorized fallback
];
const edges: XEdge[] = [
  { subject_id: 'scl', object_id: 't', interaction_category: 'pathogen_pressure' },
  { subject_id: 'aph', object_id: 't', interaction_category: 'pest_pressure' },
  { subject_id: 'myc', object_id: 't', interaction_category: 'mutualism' },
  { subject_id: 'bee', object_id: 't', interaction_category: 'pollination' },
  { subject_id: 'con', object_id: 'scl', interaction_category: 'biocontrol' },
  { subject_id: 'lady',object_id: 'aph', interaction_category: 'biocontrol' },
  { subject_id: 'nem', object_id: 't', interaction_category: 'pathogen_pressure' },
  { subject_id: 'ven', object_id: 't', interaction_category: 'pathogen_pressure' },
  { subject_id: 'lum', object_id: 'ven', interaction_category: 'biocontrol' },
  { subject_id: 'wasp',object_id: 'aph', interaction_category: 'biocontrol' },
  { subject_id: 'wasp',object_id: 'aly', interaction_category: 'flower_visitor' },  // supporter
  { subject_id: 'hyp', object_id: 'wasp', interaction_category: 'biocontrol' },     // disruptor (object is the defender)
  { subject_id: 'moth',object_id: 't', interaction_category: 'pollination', interaction_count: 2 },
  { subject_id: 'moth',object_id: 't', interaction_category: 'herbivory', interaction_count: 9 },
  { subject_id: 'wd',  object_id: 't', interaction_category: 'eats' },              // uncategorized
];

const sem = (m: Map<string, any>, id: string) => {
  const p = m.get(id); return p && { side: p.side, valence: p.valence, ring: p.ring, contextRole: p.contextRole };
};

describe('computeXLayout rings 0-1', () => {
  const m = computeXLayout({ focusId: 't', nodes, edges });
  it('crop is the centre', () => expect(sem(m, 't')).toEqual({ side: 0, valence: 0, ring: 0, contextRole: 'crop' }));
  it('fungal pathogen -> bottom-left', () => expect(sem(m, 'scl')).toEqual({ side: -1, valence: -1, ring: 1, contextRole: 'pathogen' }));
  it('insect pest -> bottom-right', () => expect(sem(m, 'aph')).toEqual({ side: 1, valence: -1, ring: 1, contextRole: 'pest' }));
  it('mutualist fungus -> top-left soil_mutualist', () => expect(sem(m, 'myc')).toEqual({ side: -1, valence: 1, ring: 1, contextRole: 'soil_mutualist' }));
  it('pollinator -> top-right', () => expect(sem(m, 'bee')).toEqual({ side: 1, valence: 1, ring: 1, contextRole: 'pollinator' }));
  it('nematode override -> LEFT despite being invertebrate', () => expect(sem(m, 'nem')).toEqual({ side: -1, valence: -1, ring: 1, contextRole: 'pathogen' }));
});

describe('computeXLayout ring 2 (biocontrol follows target side)', () => {
  const m = computeXLayout({ focusId: 't', nodes, edges });
  it('antagonist of a pathogen -> bottom-left ring 2', () => expect(sem(m, 'con')).toEqual({ side: -1, valence: -1, ring: 2, contextRole: 'pathogen_antagonist' }));
  it('predator of a pest -> bottom-right ring 2', () => expect(sem(m, 'lady')).toEqual({ side: 1, valence: -1, ring: 2, contextRole: 'pest_predator' }));
  it('parasitoid colored distinctly', () => expect(m.get('wasp').contextRole).toBe('pest_parasitoid'));
  it('CROSS-KINGDOM: earthworm controlling a fungus lands LEFT (target side, not own kingdom)', () => {
    expect(sem(m, 'lum')).toEqual({ side: -1, valence: -1, ring: 2, contextRole: 'pathogen_antagonist' });
  });
});

describe('computeXLayout ring 3 (on-demand)', () => {
  it('ring-3 absent unless the defender is expanded', () => {
    const m = computeXLayout({ focusId: 't', nodes, edges });
    expect(m.has('aly')).toBe(false);
    expect(m.has('hyp')).toBe(false);
  });
  it('expanding a defender reveals its supporter (lime) + disruptor (maroon), on its side', () => {
    const m = computeXLayout({ focusId: 't', nodes, edges, expanded: new Set(['wasp']) });
    expect(sem(m, 'aly')).toEqual({ side: 1, valence: -1, ring: 3, contextRole: 'defender_supporter' });
    expect(sem(m, 'hyp')).toEqual({ side: 1, valence: -1, ring: 3, contextRole: 'defender_disruptor' });
  });
});

describe('computeXLayout tie-break + fallback', () => {
  const m = computeXLayout({ focusId: 't', nodes, edges });
  it('higher-count antagonistic edge wins over pollination', () => expect(m.get('moth').contextRole).toBe('pest'));
  it('uncategorized edge -> neutral, mid valence', () => expect(sem(m, 'wd')).toEqual({ side: 1, valence: 0, ring: 1, contextRole: 'neutral' }));
});

describe('computeXLayout positions', () => {
  const m = computeXLayout({ focusId: 't', nodes, edges });
  it('crop sits at the origin', () => { const p = m.get('t'); expect([p.x, p.y]).toEqual([0, 0]); });
  it('left nodes have x<0, right nodes x>0', () => { expect(m.get('scl').x).toBeLessThan(0); expect(m.get('aph').x).toBeGreaterThan(0); });
  it('ring 2 is further out than ring 1 on the same side', () => { expect(Math.abs(m.get('con').x)).toBeGreaterThan(Math.abs(m.get('scl').x)); });
});
