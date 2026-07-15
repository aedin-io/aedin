import { describe, it, expect } from 'vitest';
import { composeClaimSentence } from './claim-sentence';

describe('composeClaimSentence', () => {
  it('renders disease_vector with subject=vector, object=pathogen', () => {
    expect(
      composeClaimSentence('disease_vector', 'Aphis gossypii', 'cucumber mosaic virus'),
    ).toBe('Aphis gossypii is a disease vector for cucumber mosaic virus');
  });

  it('renders disease_vector with a missing object', () => {
    expect(composeClaimSentence('disease_vector', 'Aphis gossypii', null)).toBe(
      'Aphis gossypii — is a disease vector for',
    );
  });

  it('still falls back to underscore-stripping for unknown categories', () => {
    expect(composeClaimSentence('weird_thing', 'A', 'B')).toBe('A weird thing B');
  });
});
