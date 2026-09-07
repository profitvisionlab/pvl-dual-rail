# Dual-rail LLM routing — PVL.AI semi-open

Same Tri-Tier scheduling brain, **two rails**, with a hard policy gate in code (not just docs).

| Rail | Adapter | Allowed data |
|------|---------|--------------|
| **finops** | [Together AI](https://together.ai) (primary) → [OpenRouter](https://openrouter.ai) (fallback) | `public` / `published` only |
| **enterprise** | Vertex AI Gemini (`ENTERPRISE_ADAPTER=mock` for offline proof) | `internal` / `internalContext: true` |

> Together AI is the primary FinOps provider as of **2026-09-07**; OpenRouter is the
> single fallback, engaged only when Together is unreachable, rate-limited, or its
> circuit breaker is open. NVIDIA NIM was retired the same day — see
> "Provider chain" below.

Brand: **PVL.AI**. GitHub: [`profitvisionlab/pvl-dual-rail`](https://github.com/profitvisionlab/pvl-dual-rail).

## Provider chain（2026-09-07 Ben 定案）

`finops`：**Together（主）→ OpenRouter（備援）**。OpenRouter 只在 Together 斷線、限流或斷路器跳開時接手。

**NVIDIA NIM 於 2026-09-07 除役**，adapter 已從供應鏈移除（程式碼保留在 git 歷史）。
除役的直接原因是一個實測到的事實：正式環境 `pvl-api` 的 NIM 設定在 2026-08-31 的
revision 00040／00041 掉光（金鑰、三層模型清單、DUAL_RAIL_FORCE_TIER 全沒了），
之後七天 FinOps 軌其實一直跑在 Together 上，而程式、README 與部署文件都還寫著
「NIM 是主力」。與其修回一個沒人在用、且目錄以「天」為單位變動（一天 101 顆 → 83 顆、
選定的模型量完隔天 EOL）的供應商，不如承認現況：**Together 已經是主力，就讓它是主力。**

`DUAL_RAIL_FORCE_TIER` 的理由（NIM 免費期內讓旗艦吃真實流量）也隨之消失——
**預設就該是沒有設定**，在 Together 上釘 tier3 等於每個輕量任務都付旗艦價。

TWB2B 的稽核功能直連 Anthropic＋Together、不走 OpenRouter，那是它的選擇，與本套件無關。

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
