import type { APIRoute } from 'astro';
import { getAtlasGlobiSlice } from '../../lib/queries-d1';

// SSR — returns the bounded global GloBI slice from D1. Edge-cached for a day;
// max-age=0 keeps browsers from caching while the edge serves the shared copy.
export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'public, max-age=0, s-maxage=86400' : 'no-store',
    },
  });

export const GET: APIRoute = async ({ locals }) => {
  const DB = locals.runtime?.env?.DB;
  if (!DB) return json({ error: 'no database binding' }, 500);
  try {
    const data = await getAtlasGlobiSlice(DB);
    return json(data, 200);
  } catch (e) {
    return json({ error: 'query failed' }, 500);
  }
};
