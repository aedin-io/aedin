import { describe, it, expect } from 'vitest';
import { contextColor, CONTEXT_COLOR } from './graph-context-color';

describe('contextColor', () => {
  it('maps known contextual roles to exact hex', () => {
    expect(contextColor('pathogen_antagonist')).toBe('#14B8A6');
    expect(contextColor('defender_supporter')).toBe('#84CC16');
    expect(contextColor('defender_disruptor')).toBe('#991B1B');
    expect(contextColor('pathogen')).toBe('#EC4899');
    expect(contextColor('crop')).toBe('#22C55E');
  });
  it('falls back to neutral grey for unknown roles', () => {
    expect(contextColor('something_unknown')).toBe('#94A3B8');
  });
  it('defines all 13 contextual roles', () => {
    expect(Object.keys(CONTEXT_COLOR).length).toBe(13);
  });
});
