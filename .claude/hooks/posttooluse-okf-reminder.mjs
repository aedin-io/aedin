#!/usr/bin/env node
// AEDIN PostToolUse / Edit|Write reminder. When a *structural* file changes
// (a lib module, a migration, a web page/route, or a top-level pipeline script),
// inject a non-blocking reminder to maintain the .okf/ bundle in the same pass.
// Operationalizes the CLAUDE.md "Project knowledge map" maintain-mode mandate.
// Never blocks — emits additionalContext only.

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let fp = '';
  try {
    const j = JSON.parse(raw);
    fp = (j.tool_input || {}).file_path || (j.tool_response || {}).filePath || '';
  } catch {
    process.exit(0);
  }
  if (!fp) process.exit(0);

  // Editing the bundle itself doesn't need a reminder to edit the bundle.
  if (/\/\.okf\//.test(fp)) process.exit(0);
  // Test files mirror structure but don't change it — skip to stay high-signal.
  if (/\.test\.[cm]?[jt]sx?$/.test(fp)) process.exit(0);

  const structural =
    /\/backend\/lib\//.test(fp) ||
    /\/backend\/migrations\//.test(fp) ||
    /\/web\/src\/pages\//.test(fp) ||
    // top-level backend pipeline scripts (sync-*, load-*, build-*, promote-*, extract-*, classify-*, resolve-*, reconcile-*, run-role-*)
    /\/backend\/(sync|load|build|promote|extract|classify|resolve|reconcile|run-role)[^/]*\.js$/.test(fp);

  if (!structural) process.exit(0);

  const tail = fp.split('/').slice(-2).join('/');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `OKF maintain-mode: you edited a structural file (${tail}). If this changes a ` +
          'pipeline, schema, service surface, dataset, or classification path, update the ' +
          'affected .okf/ concept(s) + .okf/log.md in THIS pass, then run okf:validate. ' +
          '(CLAUDE.md knowledge-map mandate.)',
      },
    })
  );
  process.exit(0);
});
