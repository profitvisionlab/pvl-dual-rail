# Dual-rail LLM routing — PVL.AI semi-open

Same Tri-Tier scheduling brain, **two rails**, with a hard policy gate in code (not just docs).

| Rail | Adapter | Allowed data |
|------|---------|--------------|
| **finops** | Configurable chain — default [Together AI](https://together.ai) → [OpenRouter](https://openrouter.ai); also [DeepInfra](https://deepinfra.com), [Lightning AI](https://lightning.ai) | `public` / `published` only |
| **enterprise** | Vertex AI Gemini (`ENTERPRISE_ADAPTER=mock` for offline proof) | `internal` / `internalContext: true` |

> Together AI is the primary FinOps provider as of **2026-09-07**. The chain is
> configurable since 0.3.0 (`DUAL_RAIL_FINOPS_CHAIN`); the default stays
> `together,openrouter`. NVIDIA NIM was retired on 2026-09-07 — see
> "Provider chain" below.

Brand: **PVL.AI**. GitHub: [`profitvisionlab/pvl-dual-rail`](https://github.com/profitvisionlab/pvl-dual-rail).

## Provider chain（2026-09-07 Ben 定案；0.3.0 起可設定）

`finops` 依 `DUAL_RAIL_FINOPS_CHAIN` 由左到右嘗試，前一家斷線、限流、斷路器跳開或模型全數失敗時才換下一家。

| 設定 | chain |
|---|---|
| 未設定（**預設**，與 0.2.0 相同） | `together,openrouter` |
| 三家派工（2026-09-07 定案的目標形狀） | `together,deepinfra,lightning` |

| 名稱 | 角色 | 端點（`*_BASE_URL` 可覆寫） |
|---|---|---|
| `together` | 主力 | `https://api.together.xyz/v1` |
| `deepinfra` | 同款模型備援（有同一顆 DeepSeek-V4-Flash）；長前綴／翻譯／結構化抽取首選，回報 `cachedTokens` | `https://api.deepinfra.com/v1/openai` |
| `lightning` | 聚合器：Anthropic／OpenAI／Google 一把金鑰；**最後備援**（降級到這裡＝換模型，品質基準會變） | `https://lightning.ai/api/v1` ⚠️ 取自模型頁範例，尚未以真實金鑰實打驗證 |
| `openrouter` | 舊備援（集團目前沒有可用金鑰） | `https://openrouter.ai/api/v1`（固定） |

- **沒設金鑰的供應商自動跳過**，記在結果的 `attempts`（`{ provider, skipped: 'not-configured', envVar }`）與 `skippedProviders`，**不算降級**。
- 真的試了才失敗才算降級：結果帶 `fellBack: true`、`fallbackFrom`、`fallbackChain`、`fallbackReason`。
- chain 寫錯名字丟 `DUAL_RAIL_BAD_CHAIN`；全部沒設丟 `DUAL_RAIL_FINOPS_UNCONFIGURED`；全部失敗丟 `DUAL_RAIL_FINOPS_EXHAUSTED`（都帶 `err.attempts`）。
- 各家模型清單一律由 env 提供、不內建預設（理由與挑選方法論見 `src/adapters/together.mjs` 檔頭）。
  某家有金鑰但該層沒設模型清單＝該家這次呼叫失敗（明確錯誤訊息），chain 會換下一家。
- 401／403 直接丟 `DUAL_RAIL_KEY_REJECTED`，不再把同一把壞金鑰拿去試每一顆模型。

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

每次 `chatComplete` 回傳除了 `text／model／usage／tier／rail` 之外，一律帶三個旗標
（0.3.0 另加 `toolCalls`、`message`、`cachedTokens`，見下節）：

| 欄位 | 意思 | 該怎麼辦 |
|---|---|---|
| `finishReason` | 供應商原值（`stop`／`length`／`STOP`…） | 記帳用 |
| `reasoningExhausted` | 推理把 max_tokens 吃光、沒答案 | 調高 maxTokens 或換非推理模型（adapter 會直接丟錯並換模型） |
| `truncated` | 有答案但被切斷 | `json:true` 時 router 視為失敗並升階（`DUAL_RAIL_TRUNCATED_JSON`）；散文回傳給呼叫端自行決定 |
| `cachedTokens` | `usage.prompt_tokens_details.cached_tokens`（0.3.0） | `null`＝供應商沒報（例如 Lightning），**不是**零命中 |

所有 FinOps key 在發請求前做 ASCII 預檢（`assertAsciiKey`），混進中文或換行直接丟 `DUAL_RAIL_BAD_KEY`，不再燒 96 次無效呼叫。
這兩條是從 `taiwan-b2b-bridge/src/ai/llm.ts` 的紀律抽入的，供應商無關。

## Tool calling（0.3.0，透傳）

`tools`（OpenAI function 格式）與 `toolChoice` 原樣送給四個 OpenAI 相容 adapter（Together／DeepInfra／Lightning／OpenRouter）。
本套件**只透傳、不執行工具**——工具迴圈由呼叫端負責。

```js
const tools = [{ type: 'function', function: {
  name: 'get_weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
} }]
const messages = [{ role: 'user', content: 'Weather in Taipei?' }]

const r = await chatComplete({ messages, tools, toolChoice: 'auto', sensitivity: 'public' })
if (r.toolCalls.length) {
  messages.push(r.message)                    // 原始 assistant 訊息（含 tool_calls），原樣回填一次
  for (const call of r.toolCalls) {           // [{ id, name, arguments }]，arguments 一律是字串
    const out = await myTools[call.name](JSON.parse(call.arguments))
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out) })
  }
  const final = await chatComplete({ messages, tools, sensitivity: 'public' })
}
```

| 欄位 | 意思 |
|---|---|
| `toolCalls` | 正規化後的 `[{ id, name, arguments }]`；沒有工具呼叫時是 `[]` |
| `message` | 供應商回的原始 assistant 訊息，下一輪直接 push 進 `messages` |
| `finishReason: 'tool_calls'` | 模型在等工具結果，**不算** `truncated`；只有 tool_calls、沒有文字的回覆也不會被「回覆太短」規則升階 |

**Enterprise 軌（Vertex）不支援工具**：帶 `tools`、`toolChoice` 或 tool 訊息一律丟
`DUAL_RAIL_TOOLS_UNSUPPORTED`。原因是 Vertex 的工具形狀（`functionDeclarations`）不同，
而本 adapter 把訊息攤平成文字——默默忽略會變成「模型沒呼叫工具」的假正常。
**這個錯誤不會讓呼叫改走 FinOps**：`internalContext` 的閘門優先於功能需求。

## Hard rule (verifiable)

`internalContext: true` **never** calls FinOps — and neither does
`sensitivity: 'internal'`. Requesting `rail: 'finops'` with either throws
`DUAL_RAIL_INTERNAL_ON_FINOPS`; naming the rail explicitly is not an opt-out.

```bash
npm test
# → 69/69 passed (offline: enterprise uses mock, FinOps adapters use mock fetch; no keys required)
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
    openai-compat.mjs # shared OpenAI-compatible loop, tool/usage helpers
    together.mjs      # finops primary
    deepinfra.mjs     # finops same-model fallback / long-prefix work
    lightning.mjs     # finops frontier models / last-resort aggregator
    openrouter.mjs    # finops legacy fallback
    enterprise.mjs    # Vertex (+ mock); no tool calling
scripts/
  smoke.mjs           # offline-verifiable claims (npm test)
  checks/             # mock-fetch checks: adapters, chain, tools
```

## Env

Full list in [`.env.example`](./.env.example). FinOps essentials:

| 變數 | 用途 | 預設 |
|---|---|---|
| `DUAL_RAIL_FINOPS_CHAIN` | 供應商順序（`together`／`deepinfra`／`lightning`／`openrouter`） | `together,openrouter` |
| `TOGETHER_API_KEY` | Together 金鑰 | — |
| `TOGETHER_TIER{1,2,3}_MODELS` | 各層模型（逗號分隔 fallback 鏈） | 無，必填 |
| `TOGETHER_BASE_URL` | 端點（base 或完整 `/chat/completions` 皆可） | `https://api.together.xyz/v1` |
| `DEEPINFRA_API_KEY` | DeepInfra 金鑰 | — |
| `DEEPINFRA_TIER{1,2,3}_MODELS` | 各層模型 | 無，必填 |
| `DEEPINFRA_BASE_URL` | 端點 | `https://api.deepinfra.com/v1/openai` |
| `LIGHTNING_API_KEY` | Lightning AI 金鑰 | — |
| `LIGHTNING_TIER{1,2,3}_MODELS` | 各層模型 | 無，必填 |
| `LIGHTNING_BASE_URL` | 端點（⚠️ 預設值未實打驗證） | `https://lightning.ai/api/v1` |
| `{TOGETHER,DEEPINFRA,LIGHTNING}_MAX_ATTEMPTS`／`_BACKOFF_BASE_MS`／`_TIMEOUT_MS` | 每模型重試次數／退避基數／逾時 | `3`／`100`／`45000` |
| `OPENROUTER_API_KEY`、`OPENROUTER_TIER{1,2,3}_MODELS` | OpenRouter | 見 `.env.example` |
| `DUAL_RAIL_FORCE_TIER` | 把 finops 釘在某層——**預設就該是沒有設定** | — |

Together／DeepInfra／Lightning 的設定在**呼叫當下**讀取（不是 import 時），改 env 不必重新載入模組。

## What this repo is / isn’t

**Is:** a small, copyable implementation of “compliance rail × cost rail” so outsiders can run and inspect the gate.

**Isn’t:** PVL’s article corpus, business prompts, Ghost/Supabase stack, or production IAM. Those stay private.

## License

MIT — help yourself; attribution appreciated.
