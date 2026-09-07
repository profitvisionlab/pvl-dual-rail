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

**NVIDIA NIM 於 2026-09-07 從供應鏈移除**，adapter 已刪除（程式碼保留在 git 歷史）。

這是**補完 2026-08-31 的決定**，不是新決定。當天 Ben 因「服務需要穩定」把 NIM 從
正式環境（`pvl-api` revision 00040／00041）拔掉，理由記在 `pvl-os/.env.example`
（commit 3e279e4），全部是實測：目錄變動以「天」為單位（2026-08-25 選定的 tier1／tier2
隔天就 410 EOL）、「列在 `GET /v1/models`」不等於「叫得到」（兩次抽查都有 4–6 顆實打 404）、
供應商對已 EOL 的模型仍回報 ACTIVE、主力 ultra-550b 間歇 503，且品質輸給 Together 的
DeepSeek（相似度 0.49 vs 0.53，輸出還多一倍）。

那次只動了環境變數與該檔——**本 repo 整個、`pvl-os` 的 README 與部署文件、
`/llm/selfcheck` 都還宣稱 NIM 是主力**。本次把程式與文件一次補齊。

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
