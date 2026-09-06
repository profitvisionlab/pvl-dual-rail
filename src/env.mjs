// Shared env helpers for dual-rail (no side effects).

export function envList(name, fallback = '') {
  return (process.env[name] || fallback).split(',').map((s) => s.trim()).filter(Boolean)
}

export function envInt(name, fallback) {
  const n = parseInt(process.env[name] || '', 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * API key 形狀預檢（C2，2026-09-06 自 TWB2B 稽核紀律抽入）。
 * 真實踩過：key 混進一個中文字，96 次呼叫全部死在標頭編碼，錯誤訊息是
 * `Cannot convert argument to a ByteString... value of 20320`（20320＝「你」）。
 * 在發任何請求前就擋，錯誤訊息直接說是哪把 key、第幾個字元。
 */
export function assertAsciiKey(name, key) {
  if (!key) throw new Error(`${name} missing`)
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) {
      const err = new Error(`${name} 含非 ASCII 或空白字元（位置 ${i}，code ${c}）——多半是複製時混進中文或換行`)
      err.code = 'DUAL_RAIL_BAD_KEY'
      throw err
    }
  }
  return key
}

/**
 * 統一的完成結果旗標（C1）。三個供應商的 finish_reason 語意對齊成兩個布林：
 *   reasoningExhausted — 推理把 max_tokens 吃光、沒產出答案（要調 maxTokens 或換非推理模型）
 *   truncated          — 有答案但被 max_tokens 切斷（結構化輸出＝整包報廢；散文可能勉強能用）
 * 兩者修法不同，集團在同一個坑踩過四次，所以分開記，不合成一個「失敗」。
 */
export function finishFlags(finishReason, { hasContent, hasReasoning } = {}) {
  const length = finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'MAX_TOKENS'
  return {
    finishReason: finishReason ?? null,
    reasoningExhausted: length && !hasContent && Boolean(hasReasoning),
    truncated: length && Boolean(hasContent),
  }
}
