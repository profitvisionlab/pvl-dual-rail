// DeepInfra adapter — FinOps 軌的「同款模型備援」與長前綴工作首選（2026-09-07 定案）。
//
// 角色（見 PVL docs/research/provider-eval-2026-09-07.md §3.1）：
//   · 有與 Together 同一顆 DeepSeek-V4-Flash —— 「換供應商不換模型」，品質基準不變。
//     同題實付約 Together 的 0.64 倍（該價標著 51% discount，可能是促銷，未驗證長期價）。
//   · 長前綴／翻譯／結構化抽取優先派到這裡：usage 會回
//     prompt_tokens_details.cached_tokens，快取命中可以量（結果的 cachedTokens）。
//   · fail_fast：容量滿直接 429 而非排隊 —— 對斷路器是好事，排隊會讓逾時看起來像成功。
//
// 端點：OpenAI 相容，https://api.deepinfra.com/v1/openai（DEEPINFRA_BASE_URL 可覆寫）
// 認證：Authorization: Bearer $DEEPINFRA_API_KEY
// 模型：DEEPINFRA_TIER{1,2,3}_MODELS，不內建預設（理由同 together.mjs 檔頭）。
//
// ⚠️ 評測文件只到【文件】層級：finish_reason 的逐值形狀與 tool_calls 支援度
// 需要第一次實打時確認，否則截斷可能靜默通過。

import { createOpenAICompatAdapter } from './openai-compat.mjs'

const adapter = createOpenAICompatAdapter({
  id: 'deepinfra',
  label: 'DeepInfra',
  envPrefix: 'DEEPINFRA',
  defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
  docHint: 'adapters/together.mjs 檔頭',
})

export const listDeepInfraModels = adapter.listModels
export const deepInfraTierName = adapter.tierName
export const isDeepInfraConfigured = adapter.isConfigured
export const callDeepInfra = adapter.call
