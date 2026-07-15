import type { APIRoute } from 'astro';
import { getCropGlobiCounts } from '../../lib/queries-d1';
import { SCOPE_COUNTRIES } from '../../lib/region-scopes.js';

// SSR — per-plant GloBI interaction counts for the crop-web rail badge, optionally
// region-filtered (?country=&subdivision=). Edge-cached for a day.
export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'public, max-age=0, s-maxage=86400' : 'no-store',
    },
  });

export const GET: APIRoute = async ({ locals, url }) => {
  const DB = locals.runtime?.env?.DB;
  if (!DB) return json({ error: 'no database binding' }, 500);
  const country = url.searchParams.get('country');
  const subdivision = url.searchParams.get('subdivision');
  const scope = url.searchParams.get('scope');
  const countries = scope ? (SCOPE_COUNTRIES[scope] || null) : null;
  try {
    const data = countries
      ? await getCropGlobiCounts(DB, { countries })
      : await getCropGlobiCounts(DB, { country, subdivision });
    return json(data, 200);
  } catch (e) {
    return json({ error: 'query failed' }, 500);
  }
};
