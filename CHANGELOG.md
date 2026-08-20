# Changelog

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
