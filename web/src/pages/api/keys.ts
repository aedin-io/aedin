import type { APIRoute } from 'astro';
import { createKey, revokeKey } from '../../lib/accounts/api-keys';
import { accountsEnv, json, sameOrigin } from '../../lib/accounts/server';

// POST form from /account: action=create&name=… | action=revoke&id=…
export const prerender = false;

export const POST: APIRoute = async ({ request, locals, url, redirect }) => {
  const env = accountsEnv(locals);
  if (!env) return json({ error: 'Accounts are not configured.' }, 503);
  if (!locals.user) return redirect('/login?next=/account', 303);
  if (!sameOrigin(request, url)) return json({ error: 'Bad origin.' }, 403);
  const form = await request.formData();
  try {
    if (form.get('action') === 'revoke') {
      await revokeKey(env.ACCOUNTS, locals.user.id, parseInt(String(form.get('id')), 10));
      return redirect('/account#api-keys', 303);
    }
    const { key } = await createKey(env.ACCOUNTS, locals.user.id, String(form.get('name') ?? ''));
    // Shown once on the account page; never stored in plain text.
    return new Response(null, {
      status: 303,
      headers: {
        location: '/account?newkey=1#api-keys',
        'set-cookie': `aedin_newkey=${key}; Path=/account; Max-Age=60; HttpOnly; Secure; SameSite=Strict`,
      },
    });
  } catch (e) {
    return redirect(`/account?error=${encodeURIComponent((e as Error).message)}#api-keys`, 303);
  }
};
