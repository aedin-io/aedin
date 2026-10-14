import type { APIRoute } from 'astro';
import { grant } from '../../lib/accounts/credits';
import { accountsEnv, json, sameOrigin } from '../../lib/accounts/server';

// Admin actions from /admin: manual credit adjustments and academic flag.
export const prerender = false;

export const POST: APIRoute = async ({ request, locals, url, redirect }) => {
  const env = accountsEnv(locals);
  if (!env) return json({ error: 'Accounts are not configured.' }, 503);
  if (locals.user?.role !== 'admin') return new Response('Not found', { status: 404 });
  if (!sameOrigin(request, url)) return json({ error: 'Bad origin.' }, 403);
  const form = await request.formData();
  const userId = String(form.get('userId') ?? '');
  const back = (msg: string) => redirect(`/admin?msg=${encodeURIComponent(msg)}`, 303);

  if (form.get('action') === 'academic') {
    await env.ACCOUNTS.prepare('UPDATE "user" SET academicVerified = ? WHERE id = ?')
      .bind(form.get('value') === '1' ? 1 : 0, userId).run();
    return back('Academic status updated.');
  }
  if (form.get('action') === 'credits') {
    const amount = parseInt(String(form.get('amount')), 10);
    if (!Number.isInteger(amount) || amount === 0) return back('Enter a non-zero whole number.');
    const note = String(form.get('note') ?? '').slice(0, 80);
    await grant(env.ACCOUNTS, userId, amount, 'adjustment', `${locals.user.email} ${new Date().toISOString()} ${note}`.trim());
    return back(`Adjusted by ${amount}.`);
  }
  return back('Unknown action.');
};
