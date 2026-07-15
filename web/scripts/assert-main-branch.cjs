'use strict';
/**
 * assert-main-branch — refuse a PRODUCTION Pages deploy unless we're on `main`.
 *
 * Why: production is a single Cloudflare Pages deployment, but multiple
 * concurrent sessions each work on their own feature branch. When any of them
 * runs `npm run deploy` (which targets `--branch=main`, the production alias),
 * it overwrites the whole live site with that branch's tree — silently
 * reverting everyone else's shipped work. (This happened 2026-06-22.) The cure
 * is: production deploys come from `main` only. This guard enforces that so the
 * rule is mechanical, not a convention people have to remember.
 *
 * Escape hatches:
 *   - ALLOW_NONMAIN_DEPLOY=1  → deliberate override (deploy from a non-main branch).
 *   - For a non-production *preview* of a branch, don't use `npm run deploy`; run:
 *       wrangler pages deploy dist --project-name=agroeco --branch=<preview-name>
 *     (a `--branch` other than `main` publishes a preview URL, not production.)
 */
const { execSync } = require('node:child_process');

if (process.env.ALLOW_NONMAIN_DEPLOY === '1') {
  console.warn('[deploy-guard] ALLOW_NONMAIN_DEPLOY=1 — skipping main-branch check.');
  process.exit(0);
}

let branch;
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
} catch (e) {
  console.error('[deploy-guard] could not determine git branch: ' + e.message);
  process.exit(1);
}

if (branch !== 'main') {
  console.error(
    `\n✗ Production deploy refused: current branch is '${branch}', not 'main'.\n` +
      '  Production deploys ONLY from main (it is the single production source).\n\n' +
      '  • To ship: merge your branch into main, then deploy from main.\n' +
      '  • To preview a branch live (non-production):\n' +
      '      wrangler pages deploy dist --project-name=agroeco --branch=<preview-name>\n' +
      '  • To override deliberately: ALLOW_NONMAIN_DEPLOY=1 npm run deploy\n',
  );
  process.exit(1);
}

console.log("[deploy-guard] on 'main' — production deploy allowed.");
