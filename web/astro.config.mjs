import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

// Tailwind 4 wired via PostCSS (postcss.config.mjs) — switched from
// @tailwindcss/vite on 2026-05-13 after a Rolldown/oxcResolvePlugin
// incompatibility surfaced ("Missing field tsconfigPaths on
// BindingViteResolvePluginConfig.resolveOptions"). PostCSS pipeline
// bypasses the resolver path that was failing.
//
// @astrojs/cloudflare v12.6.13 adapter is installed (v13 pinned out:
// workerd startup crash under WSL2). Site stays output:'static' (all routes
// prerendered). The adapter is inert until Plan 2 flips /entity/[slug] to
// SSR — at that point output switches to 'hybrid' and the DB binding activates.
// platformProxy: { enabled: true } wires wrangler D1 for local dev.
export default defineConfig({
  site: 'https://aedin.io',
  output: 'static',
  // imageService: 'passthrough' keeps sharp (a native lib) out of the SSR worker —
  // the default 'compile' still emits the on-demand /_image endpoint, which imports
  // the sharp service and crashes at workerd startup (process.report unimplemented).
  // This is a data/text site (only static SVGs), so no runtime image optimization needed.
  adapter: cloudflare({ platformProxy: { enabled: true }, imageService: 'passthrough' }),
  trailingSlash: 'never',
  integrations: [
    sitemap({
      changefreq: 'weekly',
      priority: 0.7
    })
  ],
  vite: {
    ssr: {
      external: ['better-sqlite3']
    }
  },
  server: {
    port: 3000,
    host: 'localhost'
  }
});
