'use strict';
/**
 * ingest-window.js — nightly-window gate + DB single-writer guard for the
 * overnight auto-resume ingestion harness (Phase 2 of the corpus plan).
 *
 * The window (default 20:00–06:00 local) is the conflict guard against the
 * Data Flow chat: aedin.sqlite is shared, so DB writes only happen overnight
 * when that chat is idle. walQuiescent() is the belt-and-suspenders check —
 * even inside the window, abort if another writer's WAL is active.
 */
const fs = require('node:fs');

function isWithinWindow(date, startHour = 20, endHour = 6) {
  const h = date.getHours();
  return h >= startHour || h < endHour; // wraps midnight
}

function msUntilWindowStart(date, startHour = 20) {
  if (isWithinWindow(date)) return 0;
  const next = new Date(date);
  next.setHours(startHour, 0, 0, 0);
  if (next <= date) next.setDate(next.getDate() + 1);
  return next - date;
}

function walQuiescent(walPath, nowMs, minIdleMs = 120000) {
  try {
    const st = fs.statSync(walPath);
    return nowMs - st.mtimeMs >= minIdleMs;
  } catch {
    return true; // no WAL → no active writer
  }
}

module.exports = { isWithinWindow, msUntilWindowStart, walQuiescent };
