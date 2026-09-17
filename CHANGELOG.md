# Changelog

## 0.3.0 — 2026-09-17

**Live-key verification (2026-09-17)** — see README「真金鑰實測」:
- DeepInfra tool round trips pass on DeepSeek-V4-Flash, Qwen3-Coder-480B Turbo, Kimi-K3.
- Lightning: gemini-2.5-flash and gpt-4.1 pass; Gemini 3／3.5 fail on the tool-result
  turn (gateway drops `thought_signature`); gpt-5.5 rejects tools (gateway forces
  `reasoning_effort`); all Anthropic models returned 503 that day.
- 5xx bodies are now included in error messages. Gateway-wrapped upstream 4xx
  (`status code: 4xx` inside a 500) is no longer retried. Known model×gateway tool
  incompatibilities raise `DUAL_RAIL_TOOLS_UNSUPPORTED` without retry, so the next
  model or provider takes over.

**New providers (FinOps rail):**
- `src/adapters/deepinfra.mjs` — DeepInfra, OpenAI-compatible
  (`https://api.deepinfra.com/v1/openai`). Same-model fallback for Together and
  first choice for long-prefix / translation / structured extraction work.
- `src/adapters/lightning.mjs` — Lightning AI, OpenAI-compatible aggregator
  (`https://lightning.ai/api/v1`; verified with a live key on 2026-09-17).
  Frontier models behind one key; last-resort fallback. OpenAI reasoning-generation
  models (`openai/gpt-5*`, `gpt-6*`, `o*`) are sent `max_completion_tokens` instead
  of `max_tokens` (the gateway 500s otherwise).
- Both follow Together's rules: `*_API_KEY`, `*_BASE_URL`, `*_TIER{1,2,3}_MODELS`
  (no built-in model lists), `assertAsciiKey`, the C1 result flags, circuit breaker.

**Configurable provider chain:**
- `DUAL_RAIL_FINOPS_CHAIN` (comma-separated). **Default unchanged:**
  `together,openrouter`. Providers without a key are skipped and recorded in
  `attempts` as `{ provider, skipped: 'not-configured', envVar }`; unknown names
  throw `DUAL_RAIL_BAD_CHAIN`. New error codes `DUAL_RAIL_FINOPS_UNCONFIGURED`
  and `DUAL_RAIL_FINOPS_EXHAUSTED` (both carry `err.attempts`).
- New exports: `resolveFinopsChain`, `DEFAULT_FINOPS_CHAIN`,
  `isDeepInfraConfigured`, `isLightningConfigured`.

**Tool calling (passthrough):**
- `chatComplete({ tools, toolChoice })` — OpenAI function format, sent as-is by
  all four OpenAI-compatible adapters. `messages` may contain `role: 'tool'` with
  `tool_call_id` and assistant messages carrying `tool_calls`.
- Results gain `toolCalls` (`[{ id, name, arguments }]`, `arguments` always a
  string) and `message` (the raw assistant message, to append for the next turn).
- `finish_reason: 'tool_calls'` is never `truncated`; a tool-call-only reply
  (empty text) no longer triggers the short-reply escalation.
- Enterprise rail (Vertex) throws `DUAL_RAIL_TOOLS_UNSUPPORTED` for tools,
  `toolChoice`, or tool messages. It never re-routes to FinOps.

**Other:**
- Results gain `cachedTokens` (`usage.prompt_tokens_details.cached_tokens`;
  `null` when the provider does not report it — e.g. Lightning — which is not the
  same as zero hits).
- Together now shares one OpenAI-compatible loop (`adapters/openai-compat.mjs`)
  with DeepInfra and Lightning. Behavior changes: env is read at call time (not
  at import), `TOGETHER_BASE_URL` accepts a base (`…/v1`) or the full
  `…/chat/completions` URL, and 401/403 now fail fast with
  `DUAL_RAIL_KEY_REJECTED` instead of trying every remaining model.
- Policy gate unchanged: `internalContext: true` / `sensitivity: 'internal'`
  still never reach FinOps, with any chain and with tools.
- Smoke suite: 19 → 69 checks, all offline (mock `fetch`, `scripts/checks/`).
- `package.json` description no longer mentions NVIDIA NIM (retired 2026-09-07).

## 0.2.0 — 2026-08-20

**Policy fix (behavior change):**
- `sensitivity: 'internal'` now blocks an explicit `rail: 'finops'` with
  `DUAL_RAIL_INTERNAL_ON_FINOPS`, matching the README's rail table. Previously
  the explicit-rail branch ran first and silently allowed internal-sensitivity
  calls onto the cost rail. Naming the rail is no longer an opt-out.

**Fixes:**
- `isEnterpriseConfigured()` no longer accepts `GOOGLE_APPLICATION_CREDENTIALS`
  it could not actually use — it now mirrors `resolveAccessToken()`
  (`VERTEX_ACCESS_TOKEN` or mock), so "configured" means "will work".

**Docs / infra:**
- README rail table and layout updated to the 2026-08-13 reality: Together AI
  is the primary FinOps provider, OpenRouter the fallback.
- GitHub-install instructions (not on the npm registry yet).
- CI: GitHub Actions smoke on Node 20/22.
- Smoke suite: 8 → 10 checks.

## 0.1.0 — 2026-08-13

Initial public release: dual-rail `chatComplete` (FinOps × Enterprise),
Tri-Tier scheduling, circuit breaker, hard `internalContext` gate, offline
smoke suite, zero runtime dependencies.
