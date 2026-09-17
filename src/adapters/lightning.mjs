// Lightning AI adapter — FinOps 軌的「前沿模型／最後備援」（2026-09-07 定案）。
//
// 角色（見 PVL docs/research/provider-eval-lightning-correction-2026-09-07.md）：
//   · 聚合器形狀：一把金鑰同時打 Anthropic／OpenAI／Google 與 lightning-ai/ 自營開源模型。
//   · 沒有 DeepSeek-V4-Flash —— 不能當 Together 的「同款」備援。
//     降級到這裡＝降級到別的模型，品質基準會換掉，所以放在 chain 的後段。
//   · 閉源模型看起來是牌價、無折扣；成本比較請用同題 completion_tokens，不要用牌價。
//
// 端點：OpenAI 相容，https://lightning.ai/api/v1（LIGHTNING_BASE_URL 可覆寫）
//   2026-09-17 真金鑰實打驗證：/models、/chat/completions、/responses 皆通。
// 認證：Authorization: Bearer $LIGHTNING_API_KEY
// 模型：LIGHTNING_TIER{1,2,3}_MODELS，不內建預設。
//
// usage.prompt_tokens_details 可能是 null —— cachedTokens 會回 null（＝沒報，不是零命中）。

import { createOpenAICompatAdapter } from './openai-compat.mjs'

const OPENAI_REASONING = /^openai\/(?:gpt-[56]|o\d)/

const adapter = createOpenAICompatAdapter({
  id: 'lightning',
  label: 'Lightning',
  envPrefix: 'LIGHTNING',
  defaultBaseUrl: 'https://lightning.ai/api/v1',
  docHint: 'adapters/together.mjs 檔頭',
  // 2026-09-17 實測：openai/gpt-5.5 帶 max_tokens 回 500「please use MaxCompletionTokens」
  maxTokensField: (model) => (OPENAI_REASONING.test(model) ? 'max_completion_tokens' : 'max_tokens'),
  // 2026-09-17 實測：OpenAI 推理世代在 /chat/completions 拒絕「推理＋tools」，
  // 走 /responses 才能帶工具（gpt-5.5、gpt-5.6 luna／terra／sol 來回成功）。
  // 不帶工具時維持 chat（五語跑分就是走 chat，行為不變）。
  // gpt-6-astra 在 Lightning 的 /responses 回「does not support the Responses API」→
  // 丟 DUAL_RAIL_TOOLS_UNSUPPORTED、換下一個模型；要讓 GPT-6 帶工具請走 openai 直連。
  // LIGHTNING_RESPONSES=never 可整個關掉（例如閘道改版時先退回 chat）。
  useResponses: (model, { tools } = {}) =>
    process.env.LIGHTNING_RESPONSES !== 'never' && Array.isArray(tools) && tools.length > 0 && OPENAI_REASONING.test(model),
})

export const listLightningModels = adapter.listModels
export const lightningTierName = adapter.tierName
export const isLightningConfigured = adapter.isConfigured
export const callLightning = adapter.call
