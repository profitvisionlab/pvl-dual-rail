// Lightning AI adapter — FinOps 軌的「前沿模型／最後備援」（2026-09-07 定案）。
//
// 角色（見 PVL docs/research/provider-eval-lightning-correction-2026-09-07.md）：
//   · 聚合器形狀：一把金鑰同時打 Anthropic／OpenAI／Google 與 lightning-ai/ 自營開源模型。
//   · 沒有 DeepSeek-V4-Flash —— 不能當 Together 的「同款」備援。
//     降級到這裡＝降級到別的模型，品質基準會換掉，所以放在 chain 的後段。
//   · 閉源模型看起來是牌價、無折扣；成本比較請用同題 completion_tokens，不要用牌價。
//
// 端點：OpenAI 相容，https://lightning.ai/api/v1（LIGHTNING_BASE_URL 可覆寫）
//   ⚠️ 這個 base URL 來自 2026-09-07 瀏覽器實機讀取模型頁的範例程式，
//   **尚未以真實金鑰實打驗證**；第一次接的時候先確認路徑與 model slug 格式。
// 認證：Authorization: Bearer $LIGHTNING_API_KEY
// 模型：LIGHTNING_TIER{1,2,3}_MODELS，不內建預設。
//
// usage.prompt_tokens_details 可能是 null —— cachedTokens 會回 null（＝沒報，不是零命中）。

import { createOpenAICompatAdapter } from './openai-compat.mjs'

const adapter = createOpenAICompatAdapter({
  id: 'lightning',
  label: 'Lightning',
  envPrefix: 'LIGHTNING',
  defaultBaseUrl: 'https://lightning.ai/api/v1',
  docHint: 'adapters/together.mjs 檔頭',
  // 2026-09-17 實測：openai/gpt-5.5 帶 max_tokens 回 500「please use MaxCompletionTokens」
  maxTokensField: (model) => (/^openai\/(?:gpt-[56]|o\d)/.test(model) ? 'max_completion_tokens' : 'max_tokens'),
})

export const listLightningModels = adapter.listModels
export const lightningTierName = adapter.tierName
export const isLightningConfigured = adapter.isConfigured
export const callLightning = adapter.call
