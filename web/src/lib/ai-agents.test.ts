import { describe, it, expect } from 'vitest';
import { classifyAiAgent, isBlockedForAi } from './ai-agents';

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

describe('classifyAiAgent', () => {
  it('treats per-query AI fetchers as retrieval agents', () => {
    for (const ua of ['Mozilla/5.0 (compatible; ChatGPT-User/1.0)', 'OAI-SearchBot/1.0', 'Claude-User/1.0', 'Perplexity-User/1.0', 'PerplexityBot/1.0']) {
      expect(classifyAiAgent(ua)).toBe('retrieval');
    }
  });

  it('treats bulk harvesters as training crawlers', () => {
    for (const ua of ['Mozilla/5.0 (compatible; GPTBot/1.2)', 'ClaudeBot/1.0', 'CCBot/2.0', 'Bytespider', 'Google-Extended']) {
      expect(classifyAiAgent(ua)).toBe('training');
    }
  });

  it('leaves browsers and search engines alone', () => {
    expect(classifyAiAgent(BROWSER)).toBeNull();
    expect(classifyAiAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBeNull();
  });
});

describe('isBlockedForAi', () => {
  it('lets retrieval agents read the knowledge base', () => {
    expect(isBlockedForAi('ChatGPT-User/1.0', '/entity/aphis-gossypii')).toBe(false);
  });

  it('blocks training crawlers except on marketing pages', () => {
    expect(isBlockedForAi('GPTBot/1.2', '/entity/aphis-gossypii')).toBe(true);
    expect(isBlockedForAi('GPTBot/1.2', '/api/atlas-globi.json')).toBe(true);
    expect(isBlockedForAi('GPTBot/1.2', '/')).toBe(false);
    expect(isBlockedForAi('GPTBot/1.2', '/api')).toBe(false);
  });

  it('never blocks browsers', () => {
    expect(isBlockedForAi(BROWSER, '/entity/aphis-gossypii')).toBe(false);
  });
});
