import type { APIRoute } from 'astro';
import { createPortal } from '../../../lib/accounts/billing';
import { accountsEnv, json, sameOrigin } from '../../../lib/accounts/server';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, url, redirect }) => {
  const env = accountsEnv(locals);
  if (!env) return json({ error: 'Accounts are not configured.' }, 503);
  if (!locals.user) return redirect('/login?next=/account', 303);
  if (!sameOrigin(request, url)) return json({ error: 'Bad origin.' }, 403);
  try {
    return redirect(await createPortal(env, env.ACCOUNTS, locals.user.id, url.origin), 303);
  } catch (e) {
    return redirect(`/account?error=${encodeURIComponent((e as Error).message)}`, 303);
  }
};
