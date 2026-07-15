#!/usr/bin/env node
// AEDIN PostToolUse / Bash reminder. When a Bash command publishes TRAIT data to
// live D1 (`wrangler d1 execute --remote` of an entity_trait_claims patch),
// inject a non-blocking reminder: conserved (climate) trait changes leave variety
// trait inheritance STALE on live, because inheritance is a derived, D1-only
// product that only the full build / this refresh tool regenerates. Never blocks.
//
// See memory `variety-trait-inheritance` + .okf/architecture/corpus-and-live-d1.md.

// Pure detector (exported for tests): does this command publish trait data to
// live D1 in a way that can drift variety inheritance?
export function shouldRemind(command) {
  if (!command) return false;
  if (!/wrangler\s+d1\s+execute/.test(command)) return false; // a D1 execute
  if (!/--remote/.test(command)) return false;                // against live (not local)
  if (/inheritance/i.test(command)) return false;             // the refresh itself — don't self-remind
  // A trait publish: a patch filename mentioning "trait", or inline entity_trait_claims SQL.
  return /trait/i.test(command) || /entity_trait_claims/i.test(command);
}

const REMINDER =
  'D1 trait publish detected. If this changed CONSERVED (climate/envelope) traits — ' +
  'ph/temp/precip/light/soil/native_regions/habitat/nitrogen_fixation — variety trait ' +
  'inheritance on live D1 is now STALE (only conserved traits inherit; inheritance is a ' +
  'derived, D1-only product). Refresh it: `node web/scripts/gen-inheritance-refresh.cjs` then ' +
  'apply via `wrangler d1 execute agroeco --remote --file=web/d1/patch-inheritance-refresh.sql`. ' +
  '(See memory variety-trait-inheritance.)';

// Run as a hook only when invoked directly (imported in tests → no stdin read).
if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let cmd = '';
    try { cmd = (JSON.parse(raw).tool_input || {}).command || ''; } catch { process.exit(0); }
    if (shouldRemind(cmd)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: REMINDER },
      }));
    }
    process.exit(0);
  });
}
