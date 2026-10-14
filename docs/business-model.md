# AEDIN business model (draft)

AEDIN follows the open-core / paid-services pattern: the code (MIT) and the
verified corpus (CC BY 4.0, Zenodo snapshot) are fully open. Revenue comes from
what a snapshot can't give you: freshness, hosted access, private extraction,
human expert review, and support.

Status: **draft for discussion.** The prices below are estimates and must be
re-derived from measured pipeline cost (see "Measured costs") before launch.

## Measured costs

Not measured yet. Run on a machine with the corpus DB, the PDFs and `backend/.env`:

```bash
cd backend
node measure-pipeline-cost.js --dry-run --sample=manifest        # page counts, $0
node measure-pipeline-cost.js --sample=manifest --max-total-spend=15
# or your own representative papers:
node measure-pipeline-cost.js --max-total-spend=15 path/to/*.pdf
```

The report (`backend/cost-measurements/<timestamp>.md`, gitignored) gives the
median/P90 cost per page and per passed claim, and the spend split across
extraction, first-pass vouch and multi-critic. Paste its summary here and set
the per-page credit price from the P90. Chat cost stays an estimate until chat
exists.

## Model

### 1. Don't close off LLM search. Gate volume and freshness instead.
- **Allow retrieval and search agents**, the ones acting on behalf of a person's query: `ChatGPT-User`, `OAI-SearchBot`, `Claude-Web`/`Claude-User`, `Perplexity-User`, `PerplexityBot`. These are a discovery channel: they cite aedin.io and bring researchers and developers to the paid API.
- **Optional: keep blocking bulk training crawlers** (`GPTBot`, `CCBot`, `Bytespider`, `Google-Extended`, `Applebot-Extended`, `Meta-ExternalAgent`, `cohere-ai`, `Diffbot`, …). This is mostly symbolic because the Zenodo dump exists, but it keeps load down and does no harm.
- **Turn the hard 403 into rate limiting** on entity, claim and data JSON routes for every automated client. Have the 429 response point to the API. This blocks bulk extraction, not reading.
- **Restore** the `text/markdown` entity dossier for allowed agents, so AI answers quote AEDIN correctly with citations.

### 2. Paid services (what people actually pay for)
In rough order of revenue potential:
1. **Hosted metered API + MCP server** (Developer/Team tiers already drafted). The selling points are a stable schema, high rate limits, query features the dump lacks (graph traversal, region filters, companion scoring), and an MCP endpoint so agent builders can plug in directly.
2. **Freshness lag:** the Zenodo/CC BY snapshot is published quarterly, and the live API has the newest verified claims. Everything stays open eventually, and freshness is what people pay for. This is the cleanest open-core lever for a data project.
3. **Extraction-as-a-service:** run the open pipeline (`backend/extract-source.js` plus the multi-critic vouching) on a customer's private or paywalled literature, extension archive or internal trial data, and deliver a private corpus. The code is open, but running it well costs LLM spend and know-how, which is the same reason people pay for hosted versions of open-source tools.
4. **Human-verified tier:** expert-reviewed claims with an SLA, for ag companies and extension services. This builds on the existing "AI-vouched, not human-verified" caveat.
5. **Institutional:** support contracts, SLAs, custom vocabularies, on-prem deployment help, citation and reporting packages for grant compliance.
6. **Non-commercial income:** grants (already being pursued), GitHub Sponsors / Open Collective, and foundation partnerships. These fit well with the academic positioning.

### 2b. Subscription, extraction pricing, accounts and chat credits

**Cost basis.** These are estimates and must be measured before the prices are set. `docs/multi-agent-architecture.md` puts multi-critic vouching at about $0.01 per claim. Sonnet extraction of a chunked paper probably costs about $0.03–0.05 per page, and a page yields about 1–2 claims. That puts the all-in LLM cost near **$0.05 per page, or roughly $1 for a 20-page paper**. A chat answer is about $0.005–0.01 (Haiku for routing, Sonnet for the answer, prompt-cached retrieval). The `lib/cost-guard` reports already log cumulative spend, so step 0 is to run 20 representative PDFs through the pipeline and record the real cost per page.

**Yes to a subscription, with one unified credit currency** rather than separate pools for API calls, extraction and chat. That means one Stripe meter and one balance, and users can spend credits on whatever they need. Retail value is 1 credit ≈ $0.01:

| Action | Credits | Retail | Est. cost | Margin |
|---|---|---|---|---|
| Extract + multi-critic vouch, per page | 25 | $0.25 | ~$0.05 | ~5× |
| Chat answer (grounded, cited) | 2 | $0.02 | ~$0.007 | ~3× |
| 100 API calls | 1 | $0.01 | ~$0 (D1 reads) | — |

| Tier | Price | Included | For |
|---|---|---|---|
| Free | $0 | Browse the site, quarterly CC BY dump, 100 API calls/day, 25 chats/mo | Students, discovery |
| Researcher | $15/mo or $150/yr (edu half price) | 2,000 credits/mo (~80 pages or 1,000 chats), live API, MCP, 1 private workspace | Academics, hobby developers |
| Pro | $79/mo, 3 seats | 12,000 credits/mo (~25 papers), shared workspaces, CSV/GloBI export of private corpora | Consultants, ag startups, labs |
| Institutional | from $5k/yr (matches `terms.astro:7`) | Custom credit pool, SSO, SLA, bulk extraction runs, human-verification add-on | Extension services, ag companies |
| Top-up | $10 / 1,000 credits | Top-up credits never expire; plan credits reset each billing period | Anyone |

**How to price extraction as a service:**
- Self-serve: charge **per page**, not per paper. Page count is known at upload, is fair across short and long papers, and shows the cost up front: "This 32-page PDF will use 800 credits." Reuse the cost-guard preflight to give that quote before the run.
- **Contribute-back discount: 50% off** when the source is open-access and the user agrees to add the verified claims to the public CC BY corpus. This grows the public corpus with paying users' money, which is the open-core flywheel. Private or paywalled uploads stay private, the user confirms they have the rights to them, and they are never published.
- Large or custom jobs (an extension archive, internal trial reports, a custom vocabulary) are **quoted per project**, at about 3–5× the measured LLM cost plus setup labor, with a minimum around $500.

**Human review of an intake (add-on, requested from the account dashboard):**
- After the AI extraction, a user can click "Request expert review" on a private corpus. You then review its claims, and they become **human-verified**: a separate badge from AI-vouched, building on the existing provenance caveat in the README.
- Price it by **claims**, not pages, because claims are what you actually review. At roughly 40 claims per hour, with your time valued at $80–100/hr, that's about **$2.50 per claim at full price**. Show the quote before submission, e.g. "This intake has 46 claims, so expert review costs $115."
- **Open-access + contribute to the public corpus:** 50% off and **moves to the top of your review queue**. Both incentives push toward growing the open corpus, so you're effectively paid to do curation you would have done anyway.
- **Closed-access / private:** full price, standard queue, and the results stay private to the account.
- Your time is the bottleneck, so **cap review slots per month**: the dashboard shows "N slots left this month", and the queue shows an ETA. Scarcity also justifies the price. Institutional contracts can buy reserved review capacity.
- You need a reviewer UI for this: an admin queue page listing pending claims with accept/edit/reject, writing to the existing verdict tables as a `human` critic.

**Why would someone pay to extract an open-access paper? Keep the option; these are the reasons:**
1. **Now instead of eventually.** Your public ingestion queue is months long. Paying means results in minutes, with the interaction graph, crop-web view and chat answers over their paper right away.
2. **Their own working set.** A researcher doing a literature review wants their 40 papers as one private, queryable, cited graph, not scattered through the global corpus. The value is in the workspace, not in any single paper.
3. **Authors want visibility.** An author pays to get their paper into AEDIN (contribute-back, discounted) so it is cited and surfaces in AI answers via MCP. This is similar to an open-access publishing fee, and it may be the strongest motive.
4. **The contribute-back discount makes it cheap**, at about $0.12 per page, so the decision is easy.

**Is chat worth including?** Yes, but as a secondary, lower-margin feature launched after the API and MCP:
- Generic ChatGPT can't give answers grounded only in verified AEDIN claims, with a verbatim quote and critic verdict trail behind every sentence. That is the differentiator.
- Chat is the only paid surface that growers and extension agents (non-developers) will use. Developers will use MCP from their own Claude/ChatGPT. That MCP path is also the right answer to "private LLMs": they reach AEDIN through a paid, metered door rather than by scraping.
- Bundling chat into credits, rather than selling it as its own plan, keeps the pricing simple and the risk low. If nobody uses chat, it costs nothing.

**Logins (built in Phase 2; setup in `docs/accounts-setup.md`):**
- **Better Auth** with its D1/SQLite adapter, running in the existing Astro SSR worker. It's open-source and self-hosted (fits the ethos) and has no per-user fees. Sign-in uses email magic links, Google and Microsoft (school/work accounts). ORCID is link-only, because it returns no email, and linking it verifies academic status. Passwords are deliberately left out: magic links cover everyone with an email address, without reset flows or credential-breach risk.
- **Stripe Billing**: Checkout plus Customer Portal for subscriptions, and Stripe Meters for credit overage. A webhook writes the plan and credit grants to D1.
- API keys are per user, hashed in D1. The API, MCP and chat endpoints check the key, then debit a `credit_ledger` table in a single atomic D1 statement.
- Migrate the waitlist (`waitlist` table): invite those signups first and offer them a launch discount.

### 3. Rollout phases
- **Phase 0: measure.** Record the real cost per page and per chat. Adjust the credit table.
- **Phase 1: AI-gating changes** (below). Small and independent.
- **Phase 2: accounts and billing.** Better Auth, Stripe, the `users`/`api_keys`/`subscriptions`/`credit_ledger` tables (new `web/d1` migration), and an account dashboard page.
- **Phase 3: metered API + MCP server** using the credit debit. Re-enable `entityMarkdown` as an MCP resource.
- **Phase 4: private extraction.** An upload, page-count quote, queue and run flow on the existing pipeline, with private workspaces. It needs a job runner, because Workers can't run the Node pipeline: a small VM or container fed by a Cloudflare Queue.
- **Phase 4b: human-review add-on.** Review request, claim-count quote, priority queue (open-access contribute-back first), monthly slot cap, admin reviewer page, and the `human` verdict badge.
- **Phase 5: chat.** RAG over D1 claims with citations, debiting credits.
