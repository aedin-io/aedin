import { defineMiddleware } from 'astro:middleware';
import { isBlockedForAi } from './lib/ai-agents';

// --- AI access policy -------------------------------------------------------
// Retrieval agents (AI search answering a person's query) get the full site;
// bulk training crawlers get only the marketing pages. See lib/ai-agents.ts for
// the rationale. robots.txt declares the same split for compliant bots, and the
// Cloudflare edge (WAF + rate-limit rules) enforces it for static pages, which
// never reach this worker.

// Agent discovery via RFC 8288 Link response headers. Runs for every SSR
// response. Static prerendered pages bypass the worker, so they don't get these.
const BASE_LINKS = [
  '</sitemap-index.xml>; rel="sitemap"',
  '<https://creativecommons.org/licenses/by/4.0/>; rel="license"',
];

// SSR pages that content-negotiate a text/markdown representation.
const negotiable = (pathname: string): boolean => pathname === '/' || pathname.startsWith('/entity/');

export const onRequest = defineMiddleware(async (ctx, next) => {
  // Block training crawlers from everything except the marketing pages, before
  // doing any rendering work.
  const ua = ctx.request.headers.get('user-agent') ?? '';
  if (isBlockedForAi(ua, ctx.url.pathname)) {
    return new Response(
      'AI training crawlers are not served the AEDIN knowledge base. The full ' +
        'corpus is CC BY 4.0 and downloadable from Zenodo ' +
        '(https://doi.org/10.5281/zenodo.21385401); live programmatic access is ' +
        'offered through the AEDIN API — see https://aedin.io/api\n',
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
