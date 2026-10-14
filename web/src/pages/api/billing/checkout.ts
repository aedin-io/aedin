import type { APIRoute } from 'astro';
import { createCheckout, isPlanId } from '../../../lib/accounts/billing';
import { accountsEnv, json, sameOrigin } from '../../../lib/accounts/server';

// POST form: kind=plan&plan=researcher&interval=monthly | kind=topup&quantity=1
export const prerender = false;

export const POST: APIRoute = async ({ request, locals, url, redirect }) => {
  const env = accountsEnv(locals);
  const user = locals.user;
  if (!env) return json({ error: 'Accounts are not configured.' }, 503);
  if (!user) return redirect('/login?next=/account', 303);
  if (!sameOrigin(request, url)) return json({ error: 'Bad origin.' }, 403);
  const form = await request.formData();
  try {
    const kind = form.get('kind');
    const plan = form.get('plan');
    const target = kind === 'topup'
      ? { kind: 'topup' as const, quantity: parseInt(String(form.get('quantity') ?? '1'), 10) }
      : isPlanId(plan) ? { kind: 'plan' as const, plan, interval: form.get('interval') === 'annual' ? 'annual' as const : 'monthly' as const }
      : null;
    if (!target) return json({ error: 'Unknown plan.' }, 400);
    return redirect(await createCheckout(env, env.ACCOUNTS, user, target, url.origin), 303);
  } catch (e) {
    return redirect(`/account?error=${encodeURIComponent((e as Error).message)}`, 303);
  }
};
