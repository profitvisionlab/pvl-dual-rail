# Dual-rail LLM routing — PVL.AI semi-open

Same Tri-Tier scheduling brain, **two rails**, with a hard policy gate in code (not just docs).

| Rail | Adapter | Allowed data |
|------|---------|--------------|
| **finops** | [OpenRouter](https://openrouter.ai) | `public` / `published` only |
| **enterprise** | Vertex AI Gemini (`ENTERPRISE_ADAPTER=mock` for offline proof) | `internal` / `internalContext: true` |

Brand: **PVL.AI**. GitHub (for now): [`sharemo168-hub/pvl-dual-rail`](https://github.com/sharemo168-hub/pvl-dual-rail). May move to org `pvl-ai` later.

## Hard rule (verifiable)

`internalContext: true` **never** calls FinOps.  
Requesting `rail: 'finops'` with internal chunks throws `DUAL_RAIL_INTERNAL_ON_FINOPS`.

```bash
npm test
# → 8/8 passed (no GCP required; enterprise uses mock)
```

## Install / use

Node ≥ 20. Zero runtime dependencies.

```js
import { chatComplete } from 'pvl-dual-rail'
// or: import { chatComplete } from './src/index.mjs'

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
  policy.mjs          # resolveRail / finopsAllowed
  router.mjs          # Tri-Tier + circuit breaker
  adapters/
    openrouter.mjs    # finops
    enterprise.mjs    # Vertex (+ mock)
scripts/smoke.mjs     # offline-verifiable claims
```

## Env

See [`.env.example`](./.env.example).

## What this repo is / isn’t

**Is:** a small, copyable implementation of “compliance rail × cost rail” so outsiders can run and inspect the gate.

**Isn’t:** PVL’s article corpus, business prompts, Ghost/Supabase stack, or production IAM. Those stay private.

## License

MIT — help yourself; attribution appreciated.
