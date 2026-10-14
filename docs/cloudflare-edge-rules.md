# Cloudflare edge rules (configured in the dashboard, not in this repo)

The SSR worker (`web/src/middleware.ts`) only sees SSR routes. Prerendered pages
(about, terms, atlas, claim/source/region/interaction) are served straight from
the edge, so the AI policy and volume cap for them live in Cloudflare. Keep these
rules in sync with `web/src/lib/ai-agents.ts` and `web/public/robots.txt`.

Policy: AI **retrieval** agents (a person's live question) may read everything;
AI **training** crawlers only see `/`, `/about` and `/api`; **every** client is
volume-capped on knowledge-base routes.

## 1. One-click AI blocking (Security → Settings, or AI Crawl Control)

- If "Block AI bots" / "AI Scrapers and Crawlers" is on, it blocks retrieval
  agents too and overrides the rules below. Turn it off, or (in AI Crawl
  Control) set AI Search / AI Assistant agents to **Allow** and AI Crawlers to
  **Block**.
- Turn **off** "Manage your robots.txt" if it is on, so `web/public/robots.txt`
  is what gets served.

## 2. Training-crawler block (Security → WAF → Custom rules)

Edit the existing AI rule (or create one). Expression (Edit expression):

```
(http.user_agent contains "GPTBot" or http.user_agent contains "ClaudeBot" or http.user_agent contains "anthropic-ai" or http.user_agent contains "CCBot" or http.user_agent contains "Bytespider" or http.user_agent contains "Amazonbot" or http.user_agent contains "Meta-ExternalAgent" or http.user_agent contains "meta-externalfetcher" or http.user_agent contains "FacebookBot" or http.user_agent contains "Diffbot" or http.user_agent contains "Omgili" or http.user_agent contains "cohere-ai" or http.user_agent contains "YouBot" or http.user_agent contains "Applebot-Extended" or http.user_agent contains "Google-Extended" or http.user_agent contains "Timpibot" or http.user_agent contains "ImagesiftBot")
and not http.request.uri.path in {"/" "/about" "/about/" "/api" "/api/"}
```

Action: **Block**. Make sure `ChatGPT-User`, `OAI-SearchBot`, `Claude-User`,
`Claude-SearchBot`, `Claude-Web`, `PerplexityBot` and `Perplexity-User` are
**not** in it any more.

## 3. Volume cap (Security → WAF → Rate limiting rules)

Create "Knowledge-base volume cap":

```
starts_with(http.request.uri.path, "/entity/") or starts_with(http.request.uri.path, "/claim/") or starts_with(http.request.uri.path, "/source/") or starts_with(http.request.uri.path, "/region/") or starts_with(http.request.uri.path, "/interaction/") or starts_with(http.request.uri.path, "/globi/") or (starts_with(http.request.uri.path, "/api/") and ends_with(http.request.uri.path, ".json"))
```

- Counting characteristic: IP.
- Threshold: **30 requests per 10 seconds** (the Free plan allows one rule with
  a 10-second period). A person reading pages never gets near this.
- Action: Block for 10 seconds. On a paid plan, set a custom 429 body:
  `Bulk access: Zenodo snapshot https://doi.org/10.5281/zenodo.21385401 or the AEDIN API at https://aedin.io/api`

## 4. Verify after deploying

```bash
curl -s -o /dev/null -w "%{http_code}\n" -A "ChatGPT-User/1.0" https://aedin.io/entity/<slug>   # 200
curl -s -A "ChatGPT-User/1.0" -H "Accept: text/markdown" https://aedin.io/entity/<slug> | head  # markdown
curl -s -o /dev/null -w "%{http_code}\n" -A "GPTBot/1.2" https://aedin.io/entity/<slug>         # 403
curl -s -o /dev/null -w "%{http_code}\n" -A "GPTBot/1.2" https://aedin.io/about                 # 200
for i in $(seq 40); do curl -s -o /dev/null -w "%{http_code} " https://aedin.io/entity/<slug>; done; echo  # ends in 429 (or 403 on Free)
```
