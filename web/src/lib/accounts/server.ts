// Request-scoped helpers for SSR pages and endpoints.
import { createAuth, type AuthEnv } from './auth';

export interface SessionUser {
  id: string; email: string; name: string; emailVerified: boolean;
  role: 'user' | 'admin'; academicVerified: boolean;
}

export function accountsEnv(locals: App.Locals): (AuthEnv & Record<string, any>) | null {
  const env = (locals as any).runtime?.env;
  return env?.ACCOUNTS ? env : null;
}

/** Cheap pre-check so pages without a session cookie never touch the DB. */
export const hasSessionCookie = (request: Request) =>
  /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(request.headers.get('cookie') ?? '');

export async function resolveUser(locals: App.Locals, request: Request): Promise<SessionUser | null> {
  const env = accountsEnv(locals);
  if (!env || !hasSessionCookie(request)) return null;
  try {
    const s = await createAuth(env).api.getSession({ headers: request.headers });
    return (s?.user as unknown as SessionUser) ?? null;
  } catch (e) {
    console.error('[auth] getSession failed', e);
    return null;
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Same-origin check for state-changing form/JSON posts (CSRF defence). */
export function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}
