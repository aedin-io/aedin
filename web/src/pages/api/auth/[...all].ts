import type { APIRoute } from 'astro';
import { createAuth } from '../../../lib/accounts/auth';
import { accountsEnv } from '../../../lib/accounts/server';

// Better Auth's handler: sign-in, callbacks, sign-out, session, account linking.
export const prerender = false;

export const ALL: APIRoute = async ({ request, locals }) => {
  const env = accountsEnv(locals);
  if (!env) return new Response('Accounts are not configured.', { status: 503 });
  return createAuth(env).handler(request);
};
