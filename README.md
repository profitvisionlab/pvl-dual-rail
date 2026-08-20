# Dual-rail LLM routing — PVL.AI semi-open

Same Tri-Tier scheduling brain, **two rails**, with a hard policy gate in code (not just docs).

| Rail | Adapter | Allowed data |
|------|---------|--------------|
| **finops** | [Together AI](https://together.ai) (primary) with [OpenRouter](https://openrouter.ai) fallback | `public` / `published` only |
| **enterprise** | Vertex AI Gemini (`ENTERPRISE_ADAPTER=mock` for offline proof) | `internal` / `internalContext: true` |

> Together became the primary FinOps provider on 2026-08-13; OpenRouter is the
> fallback. Rationale in [`src/adapters/together.mjs`](./src/adapters/together.mjs):
> an aggregation layer cannot control the jurisdiction where data lands.

Brand: **PVL.AI**. GitHub (for now): [`sharemo168-hub/pvl-dual-rail`](https://github.com/sharemo168-hub/pvl-dual-rail). May move to org `pvl-ai` later.

## Hard rule (verifiable)

`internalContext: true` **never** calls FinOps — and neither does
`sensitivity: 'internal'`. Requesting `rail: 'finops'` with either throws
`DUAL_RAIL_INTERNAL_ON_FINOPS`; naming the rail explicitly is not an opt-out.

```bash
npm test
# → 10/10 passed (no GCP required; enterprise uses mock)
```

## Install / use

Node ≥ 20. Zero runtime dependencies. Not on the npm registry yet — install
straight from GitHub:

```bash
npm install github:sharemo168-hub/pvl-dual-rail
```

```js
import { chatComplete } from 'pvl-dual-rail'
// or vendor it: import { chatComplete } from './src/index.mjs'

// Cost path — published / public only
await chatComplete({
  system: '…',
  messages: [{ role: 'user', content: '…' }],
  sensitivity: 'published',
})

// Boundary path — internal knowledge
await chatComplete({
  system: '…',
  messages: [{ role: 'user', content: '…' }],
  sensitivity: 'internal',
  internalContext: true, // hard gate
})
```

## Layout

```
src/
  index.mjs           # chatComplete
  policy.mjs          # resolveRail / finopsAllowed — the hard gate
  router.mjs          # Tri-Tier + circuit breaker
  env.mjs             # env helpers
  adapters/
    together.mjs      # finops primary
    openrouter.mjs    # finops fallback
    enterprise.mjs    # Vertex (+ mock)
scripts/smoke.mjs     # offline-verifiable claims (npm test)
```

## Env

See [`.env.example`](./.env.example).

## What this repo is / isn’t

**Is:** a small, copyable implementation of “compliance rail × cost rail” so outsiders can run and inspect the gate.

**Isn’t:** PVL’s article corpus, business prompts, Ghost/Supabase stack, or production IAM. Those stay private.

## License

MIT — help yourself; attribution appreciated.
