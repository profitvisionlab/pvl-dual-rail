// OpenAI 直連 adapter（0.4.0，2026-09-17）——FinOps 軌。
//
// 為什麼要直連（不只經 Lightning）：
//   · gpt-6-astra 帶工具**只能直連**：Lightning 的 /responses 不支援它（2026-09-17 實測）。
//   · 直連有 prompt 快取（同一段前後文重讀時輸入費約一成）；Lightning 沒有。
//   · Lightning 免費層每分鐘 15 次請求，跑分時被大量限流。
//
// 一律走 /v1/responses：OpenAI 推理世代在 /chat/completions 拒絕「推理＋tools」，
// 不帶工具時 /responses 也能用，所以只留一條路徑，少一種要維護的行為。
// 輸入輸出仍是 chat 形狀，轉換見 responses.mjs；store 一律 false。
//
// 端點：https://api.openai.com/v1（OPENAI_BASE_URL 可覆寫）
// 認證：Authorization: Bearer $OPENAI_API_KEY
// 模型：OPENAI_TIER{1,2,3}_MODELS，不內建預設（模型名不帶 openai/ 前綴，例如 gpt-5.6-luna）。

import { createOpenAICompatAdapter } from './openai-compat.mjs'

const adapter = createOpenAICompatAdapter({
  id: 'openai',
  label: 'OpenAI',
  envPrefix: 'OPENAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  docHint: 'adapters/openai.mjs 檔頭',
  useResponses: () => true,
})

export const listOpenAIModels = adapter.listModels
export const openAITierName = adapter.tierName
export const isOpenAIConfigured = adapter.isConfigured
export const callOpenAI = adapter.call
