// Together.AI adapter — FinOps 軌的「主要」供應商。
//
// 為什麼直連 Together 而不是繼續走 OpenRouter：
//
//   1. 司法管轄可控。聚合層會把請求再轉給它自己挑選的下游供應商，
//      呼叫端無法確定資料實際落在哪個機房、受哪一國法域管轄。
//      直連單一供應商只有一個對手方，資料路徑是已知的。
//
//   2. 少一層轉手。dual-rail 的硬規則是 internalContext 絕不進 FinOps；
//      減少中間人讓這條界線更容易論證。
//
//   3. 多模態同源。生圖（FLUX.2）與生影片本來就打 api.together.xyz，
//      文字也走 Together 之後，同一把金鑰、同一套額度與費率口徑，
//      不必為每個模態各養一份呼叫程式碼。
//
// 備援順序由 DUAL_RAIL_FINOPS_CHAIN 決定（預設 together,openrouter）：
// Together 掛掉、逾時、或斷路器跳開時才輪到下一家。見 ../index.mjs 的 failover 邏輯。
//
// API 形狀與 OpenAI 相容（/v1/chat/completions），實作在 openai-compat.mjs，
// 與 DeepInfra／Lightning 共用同一個迴圈；本檔只宣告設定並保留選型方法論。

import { createOpenAICompatAdapter, TIER_NAMES } from './openai-compat.mjs'

const adapter = createOpenAICompatAdapter({
  id: 'together',
  label: 'Together',
  envPrefix: 'TOGETHER',
  // TOGETHER_BASE_URL 可給 base（…/v1）或完整 …/v1/chat/completions，兩種都接受
  defaultBaseUrl: 'https://api.together.xyz/v1',
  docHint: 'adapters/together.mjs 檔頭',
})

/**
 * 三層模型，對齊 router.mjs 的 Tri-Tier：
 *   1 light    分類／抽取／JSON／清理 —— 便宜、量大
 *   2 standard 摘要／生成／比較／草稿
 *   3 flagship 程式／分析／策略／推理
 *
 * ── 為什麼這裡不寫死模型 ID ──────────────────────────────────────────
 *
 * 每一層的模型清單一律由環境變數提供，沒有內建預設。這不是疏漏，是設計：
 *
 *   · 供應商目錄變動很快。寫進原始碼的清單過期時，使用者拿到的是
 *     「看起來能跑但實際 400」的設定，而錯誤訊息不會告訴他原因。
 *   · 哪些模型划算、哪些踩雷，取決於各自的任務形狀與計價方案，
 *     別人的實測結論直接套用未必成立。
 *   · 模型選擇是營運決策，不是函式庫該替使用者做的決定。
 *
 * ── 挑模型時該量什麼（方法論）────────────────────────────────────────
 *
 * 1. **先確認是不是 serverless。** 目錄裡列著、但直接呼叫回 400 的模型很常見。
 *    上線前逐一實打一次，不要相信清單。
 *
 * 2. **標價便宜 ≠ 實付便宜。** 推理模型會把大量 token 燒在推理欄位上，
 *    實付可能是標價的數倍。比較的基準要是「同一題的 usage.completion_tokens」，
 *    不是每百萬 token 的牌價。
 *
 * 3. **推理模型的 maxTokens 不能給小。** 預算被推理吃光時，回來的是
 *    content:"" + finish_reason:"length" —— 看起來像模型壞了，其實只是沒錢寫答案。
 *    見 openai-compat.mjs 的辨識邏輯。
 *
 * 4. **輸出品質要用可判定的指標量**，不要靠感覺。例如目標語言的文體一致性、
 *    是否混入其他書寫系統、要求的結構有沒有守住。這些都能寫成程式檢查，
 *    而且**檢查器本身要先用已知答案的樣本校準** —— 否則量到的是檢查器的偏差。
 *
 * 設定方式：
 *   TOGETHER_TIER1_MODELS=modelA,modelB
 *   TOGETHER_TIER2_MODELS=modelC,modelD
 *   TOGETHER_TIER3_MODELS=modelE,modelF
 * 逗號分隔，依序當作 fallback 鏈：前一個失敗才換下一個。
 *
 * 0.3.0 起迴圈移到 openai-compat.mjs 與 DeepInfra／Lightning 共用，
 * 設定改為呼叫當下讀 env（見該檔檔頭）。對外匯出名稱不變。
 */

// 相容舊匯出：models 改成 getter，讀的是當下的 env
export const FINOPS_TIERS = Object.fromEntries(
  [1, 2, 3].map((t) => [t, {
    name: TIER_NAMES[t],
    get models() { return (process.env[`TOGETHER_TIER${t}_MODELS`] || '').split(',').map((s) => s.trim()).filter(Boolean) },
  }]),
)

export const listTogetherModels = adapter.listModels
export const togetherTierName = adapter.tierName
export const isTogetherConfigured = adapter.isConfigured

/**
 * 呼叫 Together 的 chat completions（含 tools／toolChoice 透傳）。
 * 逐一嘗試 models 陣列裡的模型，全部失敗才丟出 —— 見 openai-compat.mjs。
 */
export const callTogether = adapter.call
