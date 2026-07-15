#!/usr/bin/env node
// AEDIN PreToolUse / Bash guard. Two deterministic guardrails from CLAUDE.md:
//   1. Block bulk staging (`git add .` / `-A` / `--all`) — avoids the bash-sandbox
//      dotfile artifacts that land as char devices under backend/.claude/.
//   2. Block deploys off `main` — the team's deploy-from-main decision.
// Emits a PreToolUse permission "deny" with a reason; otherwise stays silent (allow).
import { execSync } from 'node:child_process';

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = (JSON.parse(raw).tool_input || {}).command || '';
  } catch {
    process.exit(0); // unparseable input → don't block
  }

  const deny = (reason) => {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })
    );
    process.exit(0);
  };

  // 1) Bulk git staging — block `.`, `-A`, `--all` appearing after `git add`.
  const addMatch = cmd.match(/\bgit\s+add\b/);
  if (addMatch) {
    const after = cmd.slice(addMatch.index);
    if (/(^|\s)(\.|-A|--all)(\s|$)/.test(after)) {
      deny(
        'AEDIN: stage specific files, not `git add .` / -A / --all — this avoids the ' +
          'bash-sandbox dotfile artifacts (char devices) under backend/.claude/. ' +
          'Use `git add <path> ...`. (CLAUDE.md git cadence.)'
      );
    }
  }

  // 2) Deploy guard — Pages/D1 deploys run from main only.
  if (/\bnpm\s+run\s+deploy\b/.test(cmd) || /\bwrangler\s+(pages\s+)?deploy\b/.test(cmd)) {
    let branch = '';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      /* not a git dir / detached — fall through to allow */
    }
    if (branch && branch !== 'main') {
      deny(
        `AEDIN deploy guard: deploys run from main only (current branch: ${branch}). ` +
          'Merge to main first, then deploy. (deploy-from-main decision.)'
      );
    }
  }

  process.exit(0); // allow
});
