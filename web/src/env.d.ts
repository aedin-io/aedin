/// <reference types="astro/client" />

// @astrojs/cloudflare v12: Runtime<T> generic puts bindings under
// Astro.locals.runtime.env (typed as Env & T).
// v13 changed this to a non-generic Runtime — pinned to v12 to avoid
// workerd startup crash in WSL2 (require_dist bug in @cloudflare/vite-plugin).
type D1Database = import('@cloudflare/workers-types').D1Database;
type Runtime = import('@astrojs/cloudflare').Runtime<{ DB: D1Database }>;

declare namespace App {
  interface Locals extends Runtime {}
}
