import { defineMiddleware } from 'astro:middleware';

// --- AI access policy -------------------------------------------------------
// AEDIN's knowledge base is the commercial data product; AI agents get only the
// public marketing surface. robots.txt declares this for compliant bots; this
// worker enforces it for AI user-agents that ignore robots.txt (defense-in-depth
// alongside the Cloudflare edge WAF rule). NOTE: only SSR routes reach this
// worker — static/prerendered pages (about, terms, atlas, claim/source/region/
// interaction) are covered by robots.txt + the edge rule, not here.
//
// Known AI crawler / agent user-agent tokens. These substrings do not appear in
// human browser UAs, so the match is specific (no false positives on real users).
const AI_BOT_UA =
  /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|anthropic-ai|Claude-Web|CCBot|PerplexityBot|Perplexity-User|Bytespider|Amazonbot|Meta-ExternalAgent|meta-externalfetcher|FacebookBot|Diffbot|Omgili|cohere-ai|YouBot|Applebot-Extended|Google-Extended|Timpibot|ImagesiftBot/i;

// The only paths an AI agent may reach. End-to-end exact match (no prefix) so the
// `/api/*.json` data endpoints are NOT reachable just because `/api` is allowed.
const AI_ALLOWED_PATHS = new Set(['/', '/about', '/about/', '/api', '/api/']);

// Agent discovery via RFC 8288 Link response headers. Runs for every SSR
// response. Static prerendered pages bypass the worker, so they don't get these.
const BASE_LINKS = [
  '</sitemap-index.xml>; rel="sitemap"',
  '<https://creativecommons.org/licenses/by/4.0/>; rel="license"',
];

// Only the homepage content-negotiates a text/markdown representation now (the
// front page is AI-accessible). Entity pages no longer advertise or serve it —
// they're part of the gated data product.
const negotiable = (pathname: string): boolean => pathname === '/';

export const onRequest = defineMiddleware(async (ctx, next) => {
  // Block known AI user-agents from everything except the marketing pages,
  // before doing any rendering work.
  const ua = ctx.request.headers.get('user-agent') ?? '';
  if (AI_BOT_UA.test(ua) && !AI_ALLOWED_PATHS.has(ctx.url.pathname)) {
    return new Response(
      'This page is part of the AEDIN knowledge base and is not available to ' +
        'automated AI agents. Programmatic access is offered through the AEDIN ' +
        'API — see https://aedin.io/api\n',
      {
        status: 403,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }

  const response = await next();
  const links = [...BASE_LINKS];
  if (negotiable(ctx.url.pathname)) {
    links.push(`<${ctx.url.pathname}>; rel="alternate"; type="text/markdown"`);
  }
  const existing = response.headers.get('Link');
  const value = existing ? `${existing}, ${links.join(', ')}` : links.join(', ');
  try {
    response.headers.set('Link', value);
    return response;
  } catch {
    // Some responses carry immutable headers — return a clone that can be edited.
    const cloned = new Response(response.body, response);
    cloned.headers.set('Link', value);
    return cloned;
  }
});
