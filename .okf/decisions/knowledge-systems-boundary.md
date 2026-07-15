---
type: Decision
title: Knowledge-systems boundary — what goes where
description: Three durable knowledge stores coexist (CLAUDE.md imperative rules, the .okf bundle descriptive map, and the .claude memory of cross-session facts) plus the auto-maintained .remember session-continuity buffers; this concept defines which store owns which kind of knowledge and how they cross-reference rather than duplicate.
tags: [decision, knowledge-management, okf, documentation, process]
timestamp: 2026-06-27T00:00:00Z
---

# Decision (2026-06-23, revised 2026-06-27)

AEDIN keeps a small set of distinct knowledge stores. To prevent drift and multi-maintenance, each owns one *kind* of knowledge; they **cross-link rather than duplicate**.

**Update 2026-06-27 — `docs/journal.md` retired.** The manual turnover journal was removed. In practice it went stale (untouched for ~7 days through heavy work) while the auto-maintained `.remember/` buffers became the real session-continuity layer. Continuity is now owned by `.remember/` (auto), with context-mode's FTS5 store as the searchable history; the durable stores below are unchanged. Old journal content remains recoverable from git history.

# The stores

| Store | Question it answers | Audience | Lifetime |
|-------|---------------------|----------|----------|
| **`CLAUDE.md`** | "How do I work here?" — imperative rules | agents in this repo | durable; edited in place |
| **`.okf/` bundle** | "What exists and how does it fit?" — descriptive structure | humans + agents + external/bots | durable structure; maintain-mode |
| **`.claude/…/memory/`** | "What must I remember across sessions?" — durable facts/prefs | agents across all this user's sessions | durable until wrong |
| **`.remember/`** | "Where did I leave off?" — session-to-session continuity | the next session | auto-maintained, tiered decay (now → today → recent → archive → core); local scratch |

# Routing rules (where a new fact goes)

- A new **architectural/structural** fact (a pipeline, schema, dataset, service surface, classification path, file path, design constant, or durable decision) → a **`.okf/` concept** (+ a `log.md` entry). NOT new prose in `CLAUDE.md`.
- A rule about **how to work** (commit/push cadence, branch-per-chat workflow, "always ask before X", tool conventions) → **`CLAUDE.md`**.
- "Where I left off / what happened this session" → **`.remember/`** (auto; no manual upkeep expected). Durable searchable history also lives in context-mode's FTS5 store.
- "The user prefers X" / a cross-session pointer / an external resource → **`.claude/…/memory/`** (one fact per file + a `MEMORY.md` index line).
- A **live magnitude** (entity/claim/variety counts, gate %, file sizes) → **nowhere durable**; query the DB. A stale number in a confident store is worse than no number.

# Overlap resolution

- A **durable decision** (e.g. [AI access policy](/decisions/ai-access-policy.md), [brand rename](/decisions/brand-rename-aedin.md)) keeps its **canonical body in `.okf/decisions/`**. Memory may hold a one-line *pointer* for cross-session recall; only one store holds the full text.
- When stores would duplicate, the `.okf/` bundle is the **descriptive canon**; memory points INTO it rather than re-stating it.

# Why

The `.okf/` maintain-mandate and the memory system each independently ask for upkeep. Without an explicit boundary they drift apart — the same fact in slightly-different versions — and multiply the cost of every change. One owner per kind of knowledge, plus cross-links, keeps each store thin and authoritative. The retired journal is the cautionary case: a *manual* upkeep mandate that competed with automatic capture and lost.

# Durability note (`.remember/`)

`.remember/` is currently **local-only scratch** (its files are gitignored). As the sole session-continuity layer it has no versioned/shared backup — promote distilled highlights (`core-memories.md`) into git-tracked `.claude/…/memory/`, or commit the distilled tiers, so the continuity record survives a lost working tree.

# Related

- Embodies the maintain-mode mandate in `CLAUDE.md` §"Project knowledge map".

# Citations

[1] Session 2026-06-23 — CLAUDE.md audit + OKF reconciliation; the boundary was defined to deconflict the coexisting knowledge stores.
[2] Session 2026-06-27 — journal retired in favor of `.remember/`; boundary revised to three durable stores + the continuity buffer.
