import type { APIRoute } from 'astro';
import { handleEvent, verifyWebhook } from '../../../lib/accounts/billing';
import { accountsEnv, json } from '../../../lib/accounts/server';

// Stripe webhook. Subscribe it (Stripe dashboard → Developers → Webhooks) to:
// checkout.session.completed, invoice.paid, customer.subscription.created,
// customer.subscription.updated, customer.subscription.deleted.
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = accountsEnv(locals);
  if (!env) return json({ error: 'Accounts are not configured.' }, 503);
  const body = await request.text();
  let event;
  try {
    event = await verifyWebhook(env, body, request.headers.get('stripe-signature'));
  } catch (e) {
    return json({ error: `Signature verification failed: ${(e as Error).message}` }, 400);
  }
  try {
    const outcome = await handleEvent(env, env.ACCOUNTS, event as any);
    console.log(`[stripe] ${event.type} ${event.id}: ${outcome}`);
    return json({ received: true, outcome });
  } catch (e) {
    console.error(`[stripe] ${event.type} ${event.id} failed`, e);
    return json({ error: 'processing failed' }, 500); // Stripe retries
  }
};
