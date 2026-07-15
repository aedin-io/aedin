import { describe, it, expect } from 'vitest';
import { groupNeighbors, PanelNode } from './graph-panel';

const nodes: PanelNode[] = [
  { id: 't', label: 'Tomato' },
  { id: 'scl', label: 'Sclerotinia' },
  { id: 'aph', label: 'Aphis' },
  { id: 'bee', label: 'Apis' },
];
const edges = [
  { subject_id: 'scl', object_id: 't', interaction_category: 'pathogen_pressure' },
  { subject_id: 'aph', object_id: 't', interaction_category: 'herbivory' },
  { subject_id: 'bee', object_id: 't', interaction_category: 'pollination' },
];

describe('groupNeighbors', () => {
  const groups = groupNeighbors('t', nodes, edges);
  it('groups the focus node neighbours by relation label', () => {
    const byRel = Object.fromEntries(groups.map(g => [g.relation, g.items.map(i => i.id)]));
    expect(byRel['attacked by']).toContain('scl');
    expect(byRel['eaten by']).toContain('aph');
    expect(byRel['pollinated by']).toContain('bee');
  });
  it('returns empty for a node with no edges', () => {
    expect(groupNeighbors('zzz', nodes, edges)).toEqual([]);
  });
});

describe('groupNeighbors disease_vector direction', () => {
  const vnodes: PanelNode[] = [
    { id: 'aph', label: 'Aphis gossypii' },
    { id: 'cmv', label: 'Cucumber mosaic virus' },
  ];
  const vedges = [
    { subject_id: 'aph', object_id: 'cmv', interaction_category: 'disease_vector' },
  ];
  it('labels the pathogen (object) side "vectored by"', () => {
    const g = groupNeighbors('cmv', vnodes, vedges);
    const byRel = Object.fromEntries(g.map(x => [x.relation, x.items.map(i => i.id)]));
    expect(byRel['vectored by']).toContain('aph');
  });
  it('labels the vector (subject) side "vectors"', () => {
    const g = groupNeighbors('aph', vnodes, vedges);
    const byRel = Object.fromEntries(g.map(x => [x.relation, x.items.map(i => i.id)]));
    expect(byRel['vectors']).toContain('cmv');
  });
});
