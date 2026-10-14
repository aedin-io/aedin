// API keys: `aedin_<40 hex>`. Only the SHA-256 hash is stored; the full key
// is shown to the user exactly once, at creation.
import type { D1Like } from './db';
import { nowIso } from './db';

const PREFIX = 'aedin_';
export const MAX_KEYS_PER_USER = 10;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return PREFIX + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createKey(db: D1Like, userId: string, name: string) {
  const active = await db.prepare('SELECT COUNT(*) AS n FROM api_key WHERE user_id = ? AND revoked_at IS NULL')
    .bind(userId).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_KEYS_PER_USER) throw new Error(`At most ${MAX_KEYS_PER_USER} active keys.`);
  const key = generateKey();
  const prefix = key.slice(0, PREFIX.length + 6);
  await db.prepare('INSERT INTO api_key (user_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, name.trim().slice(0, 64) || 'Untitled key', prefix, await sha256Hex(key), nowIso()).run();
  return { key, prefix };
}

export async function listKeys(db: D1Like, userId: string) {
  const r = await db.prepare(
    `SELECT id, name, prefix, created_at, last_used_at FROM api_key
      WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC`,
  ).bind(userId).all<{ id: number; name: string; prefix: string; created_at: string; last_used_at: string | null }>();
  return r.results ?? [];
}

export async function revokeKey(db: D1Like, userId: string, id: number): Promise<boolean> {
  const r = await db.prepare('UPDATE api_key SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(nowIso(), id, userId).run();
  return (r.meta?.changes ?? 0) === 1;
}

/** Resolve a presented key to its user id (null if unknown or revoked). */
export async function verifyKey(db: D1Like, key: string | null | undefined): Promise<string | null> {
  if (!key || !key.startsWith(PREFIX) || key.length !== PREFIX.length + 40) return null;
  const hash = await sha256Hex(key);
  const row = await db.prepare('SELECT id, user_id FROM api_key WHERE key_hash = ? AND revoked_at IS NULL')
    .bind(hash).first<{ id: number; user_id: string }>();
  if (!row) return null;
  await db.prepare('UPDATE api_key SET last_used_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
  return row.user_id;
}
