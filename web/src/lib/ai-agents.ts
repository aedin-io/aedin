// AI user-agent classification for the access policy in middleware.ts.
//
// AEDIN's data is CC BY 4.0 and published as a bulk snapshot on Zenodo, so the
// policy gates *how* AI reaches the site, not *whether* it can see the data:
//
// - Retrieval agents fetch a page on behalf of a person's live question (AI
//   search / answer engines). They cite aedin.io and are a discovery channel,
//   so they get the full knowledge base, including markdown dossiers.
// - Training crawlers bulk-harvest for model training. They get only the public
//   marketing pages; the Zenodo snapshot and the metered API are the supported
//   bulk routes.
//
// Volume from any client is capped by the Cloudflare edge rate-limit rule, not
// here. Keep public/robots.txt in sync with these lists.

export const RETRIEVAL_AGENT_UA =
  /ChatGPT-User|OAI-SearchBot|Claude-User|Claude-SearchBot|Claude-Web|Perplexity-User|PerplexityBot/i;

export const TRAINING_CRAWLER_UA =
  /GPTBot|ClaudeBot|anthropic-ai|CCBot|Bytespider|Amazonbot|Meta-ExternalAgent|meta-externalfetcher|FacebookBot|Diffbot|Omgili|cohere-ai|YouBot|Applebot-Extended|Google-Extended|Timpibot|ImagesiftBot/i;

// Paths a training crawler may reach. Exact match (no prefix) so the
// `/api/*.json` data endpoints are NOT reachable just because `/api` is allowed.
export const TRAINING_ALLOWED_PATHS = new Set(['/', '/about', '/about/', '/api', '/api/']);

export type AiAgentClass = 'retrieval' | 'training' | null;

export function classifyAiAgent(ua: string): AiAgentClass {
  // Retrieval is checked first: no token in one list is a substring of the other,
  // but if a vendor ever sends both, the per-query fetch is the more specific signal.
  if (RETRIEVAL_AGENT_UA.test(ua)) return 'retrieval';
  if (TRAINING_CRAWLER_UA.test(ua)) return 'training';
  return null;
}

export function isBlockedForAi(ua: string, pathname: string): boolean {
  return classifyAiAgent(ua) === 'training' && !TRAINING_ALLOWED_PATHS.has(pathname);
}
