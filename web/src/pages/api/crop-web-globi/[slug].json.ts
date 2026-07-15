import type { APIRoute } from 'astro';
import { getCropWebGlobi } from '../../../lib/queries-d1';
import { SCOPE_COUNTRIES } from '../../../lib/region-scopes.js';

// SSR — reads the live D1 binding on demand. Edge-cached for a day (max-age=0
// keeps browsers from caching while the edge serves the shared copy); the data
// only changes on a D1 reload (a deploy-time event), so a long s-maxage is safe.
export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'public, max-age=0, s-maxage=86400' : 'no-store',
    },
  });

export const GET: APIRoute = async ({ params, locals, url }) => {
  const slug = params.slug;
  const DB = locals.runtime?.env?.DB;
  if (!DB) return json({ error: 'no database binding' }, 500);
  if (!slug) return json({ error: 'missing slug' }, 400);

  const country = url.searchParams.get('country');
  const subdivision = url.searchParams.get('subdivision');
  const scope = url.searchParams.get('scope');
  const countries = scope ? (SCOPE_COUNTRIES[scope] || null) : null;

  try {
    const focus = await DB.prepare(
      `SELECT id, slug FROM entities WHERE slug = ? LIMIT 1`,
    ).bind(slug).first<{ id: number; slug: string | null }>();
    if (!focus) return json({ error: 'not found', slug }, 404);

    const data = countries
      ? await getCropWebGlobi(DB, focus, { countries })
      : await getCropWebGlobi(DB, focus, { country, subdivision });
    return json(data, 200);
  } catch (e) {
    return json({ error: 'query failed' }, 500);
  }
};
