// Minimal D1 surface used by the accounts code. Cloudflare's D1Database
// satisfies it; tests use a better-sqlite3 shim (test/d1-shim.ts).
export interface D1Result<T = unknown> {
  results?: T[];
  meta?: { changes?: number; last_row_id?: number };
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
}

export const nowIso = () => new Date().toISOString();
