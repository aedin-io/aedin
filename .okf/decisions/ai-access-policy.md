---
type: Decision
title: AI access policy
description: AI agents are restricted to a narrow public surface; all data pages/endpoints are blocked while search engines are allowed — an asymmetric moat complementing a metered API.
tags: [decision, ai-access, security, moat, waf]
timestamp: 2026-06-23T00:00:00Z
---

# Decision (shipped 2026-06-23, live)

AI agents are restricted to `/`, `/about`, `/api` (the funnel) only; **all data pages and data endpoints are blocked** for AI agents, while **search engines are allowed** (SEO preserved).

# Three enforcement layers

1. **`robots.txt`** (in git).
2. **An SSR worker** check (in git).
3. **A Cloudflare WAF custom rule** that lives **only in the dashboard** — NOT in git. If AI-access behavior looks wrong, check the Cloudflare WAF first.

# Rationale

An asymmetric moat: humans + search engines get the public site; bots are funneled to the (future) **metered API** rather than scraping the data pages. Complements the metered-API monetization plan.

# Related

- Governs the [web site](/services/web-site.md) and [backend API](/services/backend-api.md) surfaces.

# Citations

[1] memory `ai-access-policy` (PROJECT, shipped 2026-06-23, main e5e5765, live).
