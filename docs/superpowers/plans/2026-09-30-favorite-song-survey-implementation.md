# Favorite Song Survey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute tasks with TDD, report files and scoped reviews. User approved this spec and explicitly authorized immediate implementation, so no repeated design/execution approval gate.

**Goal:** Build the approved Japanese survey PWA, secure cloud API, researched song catalog and complete PC SQLite collection.
**Architecture:** Single npm project: React/Vite client in `web/`, Worker/D1 in `worker/`, contracts in `shared/`, Python collector in `collector/`. GitHub Pages frontend talks to a workers.dev API. D1 is authoritative; local SQLite mirrors business data including audit history.
**Tech Stack:** TypeScript, React, Vite, Cloudflare Workers/D1, Vitest + Miniflare or Wrangler local real D1 integration tests, Python 3.11 stdlib sqlite3/unittest, browser end-to-end checks.
**Spec:** ../specs/2026-09-30-favorite-song-survey-design.md

## Global Constraints

- Japanese responsive light UI. Landing view is answering a song. Initial audience 2–10 people.
- Models: GPT-6.1 Sol / high owns architecture and critical implementation; GPT-6 Luna / xhigh owns UI and peripheral implementation. Root coordinates; never delegate critical decisions to Luna.
- Only admin password. Guest identity uses secret device capabilities, independent of public selected name; invitation tokens are single use. Support device addition and admin revocation. Never expose credentials in business exports/logs.
- Own-record edits only; admin edits all and effective audit corrections. Preserve original events and correction events. Public endpoints never return deleted records or audit payloads.
- One active participant/version/date record per day; idempotent operation IDs; compare expected revision to reject concurrent overwrite. Mutations and audit/change feed must be atomic.
- Rankings use record COUNTS (not unique supporters), default grouped by original work. A on 3 days+B on 1 day means 4 records/2 supporters. JST, Monday start, record_date determines periods.
- Weekly 12-week tag series: count and percentage, denominator all active responses including unparsed. Multiple tags can sum above 100. Separate vocalist/composer/release-name/uploader and aliases, original/cover/remix.
- Web evidence only; configured Groq model qwen/qwen3.8-27b plus Tavily. 50 initial tags/7 categories, missing evidence unconfirmed, keep sources. No listening, no fabricated credits/tags, no silent overwrite of admin-corrected metadata.
- New offline records queued persistently and replayed with captured identity/op ID, existing edits/admin operations require online. Don't claim saved-to-cloud until HTTP success. Browser closure means replay at next launch (no mandatory background sync).
- Workers/D1 free, no automatic upgrade. Research credit cap initially 800/month. Durable research queue, bounded retries, shared cached results, small jobs, admin usage/last-sync status.
- PC read-only mirror via authenticated cursor/high-watermark feed, Windows logon+5-minute schedule, daily backup 30 days. No bidirectional sync or arbitrary SQL UI.
- Do not publish production with demo credentials, demo answers or dummy research. Real cloud setup secrets are provided locally, never via chat. Seed 50 tags; 4 sample songs are marked user-provided metadata until sources verified (URL correction for Telepathy is c56TpxfO9q0).

## Review Focus

- Public name selection and tampered participant IDs cannot authorize writes; invite replay cannot claim identities twice.
- Concurrent duplicate inserts/updates/deletes and retrying operation IDs leave exactly one coherent mutation and event.
- Deleted and corrected history remains exportable, all business mutations appear in PC feed, schema/cursor mismatch does not discard data.
- Catalog normalization must not merge different recordings by title; resolving unresolved duplicates reports conflict, not data loss.
- Failed APIs, expired identities and offline restart never lose queued answers or submit as a newly selected participant.

## Task 1: Critical cloud foundation — Sol / high

**Files:** package/TypeScript/Vitest/Wrangler configs; shared/contracts.ts; worker/schema/*.sql; worker/src/{index,auth,store,statistics,catalog,tags}.ts; worker/tests/*; docs/api-contract.md.
**Interfaces:** Worker exports default {fetch(request,env,ctx), scheduled(controller,env,ctx)}; shared/contracts.ts owns stable JSON types; web will consume `/api/v1`. API returns `{data:...}` on success and `{error:{code,message}}` on failures. Health returns configuration flags only. Env keys DB, ADMIN_PASSWORD_HASH, ALLOWED_ORIGINS, GROQ_API_KEY, TAVILY_API_KEY, SYNC_TOKEN_HASH, GROQ_MODEL. Authentication uses `Authorization: Bearer ...`; guest token stored hashed, admin sessions expire. Public data contains no capability/session/invite hashes.

Required API groups: public participants/catalog search/song detail/records/statistics/tags; guest create/claim/device transfer; own response POST/PATCH/DELETE; admin login/logout, participants/invites/devices, records, catalog/entities/aliases/credits/tags, audit listing/correction, jobs/usage/sync status; dedicated sync feed and acknowledgement. Define exact route/body types in docs/api-contract.md before report, so Luna can work without architectural guesses. List-row editing must be typed by table and preserve audit, never execute arbitrary SQL.

- [ ] Write real-D1 HTTP integration tests first: registered A can't edit B, bad admin password, invite replay, same-day duplicate + cross-day counts, idempotent replay, revision conflict, delete excluded public but present audit/feed, audit correction original retained, aliases/versions/roles in stats, schema high-watermark pagination and JSON business export security.
- [ ] Run RED; implement root npm project and backend to turn those assertions GREEN. Use actual SQLite/D1 for concurrency-sensitive tests, not only mocked D1 statements. Document RED/GREEN evidence.
- [ ] Provide `npm run dev:api`, `npm run dev:web` (config only; no UI implementation), `npm test`, `npm run typecheck`, `npm run build`, and `npm run db:migrate:local`. Bind local API to 127.0.0.1:8787. Keep web build placeholder until Task 2; don't write UI files.
- [ ] Verify backend tests and Worker typecheck. Commit only owned files. Write `.superpowers/sdd/favorite-song-survey/task-1-report.md` (ignored), then return status/commit/test summary/concerns.

## Task 2: User interface and PWA — Luna / xhigh

**Files:** web/*; index.html; vite.config.ts as necessary; web tests; icons/manifest/service worker; UI-specific dependencies only if needed (coordinate root package changes).
**Interfaces:** Read docs/api-contract.md and shared/contracts.ts from Task 1. Consume real API; production VITE_API_BASE_URL. No fake production store. Persist guest credentials separately from selected-view participant. Admin token memory only, never cache audit/admin payloads with shared data.

- [ ] Write tests for new-user answer flow, candidate ambiguity, queued-offline captured identity + restart + idempotent replay, ownership controls, admin table editing and log correction, display ranking count/supporters and tag graph ratios. Observe RED.
- [ ] Implement answer, rankings, personal history/stats + charts, own edit/delete, guest claim/transfer links/QR, admin password screen and tabs: participants/devices, catalog/entities/aliases/credits/tags, all records, database forms, audit corrections, job/usage/sync status. Use accessible labels, Japanese messages, responsive polished light design. Admin operations require network. Conditional fields reflect route contract.
- [ ] Add PWA manifest, local icons, SW shell caching and public snapshot caching; offline outbox; update notification; app startup/online replay. Don't persist privileged query results in public cache or SW HTTP cache.
- [ ] Run UI tests, typecheck/build. Commit owned files; report RED/GREEN and concerns to task-2-report.md.

## Task 3: Research pipeline — Sol / high

**Files:** worker/src/research/*; worker/tests/research*; shared/contracts.ts only compatible additions; admin job routes if absent.
**Interfaces:** Durable job stages, budget ledger and catalog/credit/tag updates use Task 1 audited store. scheduled handler processes one bounded stage per invocation. Results consumed by existing UI. Pure fetch dependency injection for provider fixture tests is allowed; actual D1 remains real.

- [ ] Test invalid JSON, unlisted tag IDs, unsupported credits/source URL, search/title mismatch, multiple candidates, 429/retry, concurrency budget reservation, model failure, cache reuse, admin lock preservation, and completed metadata/aliases changes in sync feed. Observe RED.
- [ ] Implement basic Tavily search and bounded source extraction, Groq JSON-mode validation with allowlisted tags and evidence IDs. Only source-backed values committed. Failed data remains pending/needs-review and original answer is retained. No arbitrary URL fetching/SSRF. Parse URLs without tracking parameters.
- [ ] Expose research retry/review, warnings and usage. If keys absent, clearly configured=false/pending; no invented results. Query minimal bounded response sizes for Workers free CPU.
- [ ] Run tests, Worker typecheck. Commit and report task-3-report.md.

## Task 4: PC mirror and deployment setup — Sol / high

**Files:** collector/*; scripts/setup-* and scripts/install-collector.ps1; README.md; .env.example/.dev.vars.example (placeholders only); .github/workflows/pages.yml; docs/setup.md; collector/tests/*.
**Interfaces:** Consume Task 1 feed contract using Python urllib/sqlite3 stdlib; validate schema/version/cursor/high-watermark, transactional apply and cursor checkpoint; SQLite stores typed queryable business tables plus unchanged events. Sync qualification tokens never exported to business DB. Provide SQL example queries, 30 daily snapshots, API ack last success only. A feed page cannot split transaction boundaries unsafely.

- [ ] Test interrupted/repeated pages, delete/correction replay, append-only snapshots, schema mismatch, malicious table names, retry and cursor rollback, daily backup retention, all accepted business tables and Unicode. Observe RED.
- [ ] Implement collector CLI (once/watch/configure), hidden Windows task at logon+5 minutes with absolute verified paths. Use native PowerShell file ops only; register task only after secrets/config available. No PC inbound port.
- [ ] Provide local private setup that stores API credentials without printing values, generates salted admin password verifier, writes Worker secret config, provisions ONLY Workers Free+D1, sets Github frontend API URL, runs migrations/seed, configure collector. Never enable paid products or mutate unrelated projects. Keep all private .env/data outside Git. Document user-specific tasks.
- [ ] Run Python tests and all affected tests/build; commit and report task-4-report.md.

## Task 5: Integration, reviews and release — Sol / high

**Files:** focused fixes only; docs/verification.md; scripts/e2e*; release config as required.
- [ ] Run full suites/build, start local real Worker + real React UI, verify browser two-participant/admin flows, persisted reload/offline answers, catalog changes and collector equality. Write regression tests before discovered fixes.
- [ ] Generate file-backed diff review packages for each completed task and a whole-branch review; use Sol/high for security/review, Luna/xhigh for ordinary UI fixes. Resume original agent for fixes. Don't mark unverified constraints passed.
- [ ] Check local config credential presence without logging values; `wrangler whoami`, inspect GitHub repository identity; create new favorite-song-survey-pwa repo only if absent, never overwrite another application.
- [ ] Deploy real API and migrate D1 once credentials ready; point Pages build to verified API, check live raw files/Pages run and runtime SW/public response/admin/collector. Without necessary credentials, finish all independent local work and report exact remaining setup; do not claim full live acceptance.
- [ ] Preserve accepted plan HTML and verification reports. Finish with clickable files, actual URL, tests and actual hardware coverage. No unsolicited PR requirement.
