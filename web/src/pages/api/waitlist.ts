import type { APIRoute } from 'astro';
import { normalizeEmail, verifyTurnstile, sanitizeUseCases } from '../../lib/waitlist';

// SSR — accepts API-interest waitlist signups and stores them in D1.
// POST only; multipart/urlencoded form body. Honeypot + (optional) Turnstile
// spam guard. See commercial-bd-plan.md §12 for the broader API roadmap this
// feeds (the captured list seeds the BD-plan Day-30 CRM import).
export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const env = (locals as any).runtime?.env;
  const DB = env?.DB;
  if (!DB) return json({ error: 'Waitlist is temporarily unavailable.' }, 503);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Bad request.' }, 400);
  }

  // Honeypot: a hidden field real users never see. If a bot fills it, return
  // a fake success (don't tip off the bot) but drop the submission.
  if (((form.get('company') as string) ?? '') !== '') return json({ ok: true });

  const email = normalizeEmail(form.get('email'));
  if (!email) return json({ error: 'Please enter a valid email address.' }, 400);

  const ip = request.headers.get('cf-connecting-ip') ?? clientAddress ?? null;
  const token = (form.get('cf-turnstile-response') as string) ?? null;
  if (!(await verifyTurnstile(env?.TURNSTILE_SECRET, token, ip))) {
    return json({ error: 'Verification failed. Please try again.' }, 400);
  }

  const interest = ((form.get('interest') as string) || 'api').slice(0, 64);
  const source = ((form.get('source') as string) || 'unknown').slice(0, 128);
  const useCases = sanitizeUseCases(form.getAll('use_cases'));
  const createdAt = new Date().toISOString();

  try {
    await DB.prepare(
      `INSERT OR IGNORE INTO waitlist (email, interest, source, use_cases, created_at, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(email, interest, source, useCases, createdAt, ip)
      .run();
  } catch {
    return json({ error: 'Could not save your email. Please try again later.' }, 500);
  }

  // Fire-and-forget admin notification to Discord — never affects the signup
  // result. WAITLIST_WEBHOOK_URL is a Pages secret (NOT in the repo); absent = no-op.
  const webhook = env?.WAITLIST_WEBHOOK_URL;
  if (webhook) {
    const notify = fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'AEDIN waitlist',
        embeds: [
          {
            title: 'New API waitlist signup',
            color: 0x3b7a57,
            fields: [
              { name: 'Email', value: email, inline: true },
              { name: 'Use cases', value: useCases || '(none selected)', inline: true },
              { name: 'Source', value: source },
            ],
            timestamp: createdAt,
          },
        ],
      }),
    }).catch(() => {});
    const ctx = (locals as any).runtime?.ctx;
    if (ctx?.waitUntil) ctx.waitUntil(notify);
    else await notify;
  }

  return json({ ok: true });
};

// Anything other than POST is not allowed.
export const ALL: APIRoute = () => json({ error: 'Method not allowed.' }, 405);
