# Dual-rail LLM routing — PVL.AI semi-open

Same Tri-Tier scheduling brain, **two rails**, with a hard policy gate in code (not just docs).

| Rail | Adapter | Allowed data |
|------|---------|--------------|
| **finops** | [NVIDIA NIM](https://build.nvidia.com) (primary) → [Together AI](https://together.ai) → [OpenRouter](https://openrouter.ai) fallback chain | `public` / `published` only |
| **enterprise** | Vertex AI Gemini (`ENTERPRISE_ADAPTER=mock` for offline proof) | `internal` / `internalContext: true` |

> NVIDIA NIM became the primary FinOps provider on 2026-08-25, for the
> six-month free/high-quota window (through 2027-02-25) — rationale in
> [`src/adapters/nim.mjs`](./src/adapters/nim.mjs). Together and OpenRouter
> stay wired in as the second and third fallback; re-evaluate the order once
> the free window ends.

Brand: **PVL.AI**. GitHub: [`profitvisionlab/pvl-dual-rail`](https://github.com/profitvisionlab/pvl-dual-rail).

## Fallback order（2026-09-06 Ben 定案）

`finops`：NIM → Together → **OpenRouter 留在最後當備胎**。TWB2B 的稽核功能直連 Anthropic＋Together、不走 OpenRouter，
那是它的選擇；集團 dual-rail 的第三層不拆。

## Result shape（C1，2026-09-06）

每次 `chatComplete` 回傳除了 `text／model／usage／tier／rail` 之外，一律帶三個旗標：

| 欄位 | 意思 | 該怎麼辦 |
|---|---|---|
| `finishReason` | 供應商原值（`stop`／`length`／`STOP`…） | 記帳用 |
| `reasoningExhausted` | 推理把 max_tokens 吃光、沒答案 | 調高 maxTokens 或換非推理模型（adapter 會直接丟錯並換模型） |
| `truncated` | 有答案但被切斷 | `json:true` 時 router 視為失敗並升階（`DUAL_RAIL_TRUNCATED_JSON`）；散文回傳給呼叫端自行決定 |

三把 FinOps key 在發請求前做 ASCII 預檢（`assertAsciiKey`），混進中文或換行直接丟 `DUAL_RAIL_BAD_KEY`，不再燒 96 次無效呼叫。
這兩條是從 `taiwan-b2b-bridge/src/ai/llm.ts` 的紀律抽入的，供應商無關。

## Hard rule (verifiable)

`internalContext: true` **never** calls FinOps — and neither does
`sensitivity: 'internal'`. Requesting `rail: 'finops'` with either throws
`DUAL_RAIL_INTERNAL_ON_FINOPS`; naming the rail explicitly is not an opt-out.

```bash
npm test
# → 11/11 passed (no GCP required; enterprise uses mock)
```

## Install / use

Node ≥ 20. Zero runtime dependencies. Not on the npm registry yet — install
straight from GitHub:

```bash
npm install github:profitvisionlab/pvl-dual-rail
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
    nim.mjs           # finops primary (through 2027-02-25)
    together.mjs      # finops 2nd fallback
    openrouter.mjs    # finops 3rd fallback
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
