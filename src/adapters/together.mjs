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
// OpenRouter 保留為備援：Together 掛掉、逾時、或斷路器跳開時才接手。
// 見 ../index.mjs 的 FinOps 軌 failover 邏輯。
//
// API 形狀與 OpenAI 相容（/v1/chat/completions），所以這支適配器
// 刻意維持與 openrouter.mjs 相同的匯出介面，router 不需要知道差別。

import { envInt, envList } from '../env.mjs'

const API_URL = process.env.TOGETHER_BASE_URL || 'https://api.together.xyz/v1/chat/completions'
const MAX_ATTEMPTS = envInt('TOGETHER_MAX_ATTEMPTS', 3)
const BACKOFF_BASE_MS = envInt('TOGETHER_BACKOFF_BASE_MS', 100)
const REQUEST_TIMEOUT_MS = envInt('TOGETHER_TIMEOUT_MS', 45_000)

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
 *    見下方 callTogether 的辨識邏輯。
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
 */
export const FINOPS_TIERS = {
  1: { name: 'light', models: envList('TOGETHER_TIER1_MODELS', '') },
  2: { name: 'standard', models: envList('TOGETHER_TIER2_MODELS', '') },
  3: { name: 'flagship', models: envList('TOGETHER_TIER3_MODELS', '') },
}

export function listTogetherModels(tier) {
  const models = FINOPS_TIERS[tier]?.models
  // 空清單會讓 runTier 拿到零個模型後靜默跳過整層，看起來像「這層沒失敗」。
  // 寧可在這裡明確炸掉，訊息直接指出要設哪個環境變數。
  if (!models?.length) {
    throw new Error(
      `TOGETHER_TIER${tier}_MODELS 未設定。本套件不內建模型清單 —— ` +
        `供應商目錄變動快，寫死的預設過期時會變成「看似能跑但實際 400」。` +
        `請依 adapters/together.mjs 檔頭的挑選方法論自行實測後填入（逗號分隔）。`,
    )
  }
  return models.slice()
}

export function togetherTierName(tier) {
  return FINOPS_TIERS[tier]?.name || `tier${tier}`
}

export function isTogetherConfigured() {
  return Boolean(process.env.TOGETHER_API_KEY)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 呼叫 Together 的 chat completions。
 *
 * 逐一嘗試 models 陣列裡的模型：某個模型 404／限流就換下一個，
 * 全部失敗才丟出 —— 與 openrouter.mjs 的行為一致，讓 router 可以互換。
 */
export async function callTogether({ models, system, messages, maxTokens, json }) {
  const key = process.env.TOGETHER_API_KEY
  if (!key) throw new Error('TOGETHER_API_KEY missing')

  const payload = (model) => ({
    model,
    messages: [
      // system 可能是字串或 cache_control 區塊陣列（buildCachedSystem 產生）。
      // Together 不支援 Anthropic 的 cache_control，收到陣列時攤平成純文字，
      // 否則 API 會 400。
      ...(system
        ? [{ role: 'system', content: Array.isArray(system) ? system.map((b) => b.text ?? '').join('\n\n') : system }]
        : []),
      ...messages,
    ],
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  })

  let lastErr = null

  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload(model)),
          signal: ctl.signal,
        })

        if (res.status === 429 || res.status >= 500) {
          // 可重試：限流或對方伺服器問題
          lastErr = new Error(`Together ${res.status} on ${model}`)
          await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
          continue
        }
        if (!res.ok) {
          // 不可重試（400/401/404…）→ 換下一個模型
          const body = await res.text().catch(() => '')
          lastErr = new Error(`Together ${res.status} on ${model}: ${body.slice(0, 160)}`)
          break
        }

        const jsonBody = await res.json()
        const choice = jsonBody?.choices?.[0]
        const text = choice?.message?.content

        if (typeof text === 'string' && text.length) {
          return {
            text,
            model,
            provider: 'together',
            usage: jsonBody.usage ?? null,
            // 推理模型會另外回 reasoning；保留供除錯，但不當成答案
            ...(choice?.message?.reasoning ? { reasoning: choice.message.reasoning } : {}),
          }
        }

        // ⚠️ 部分推理模型把思考放在 message.reasoning，
        // content 要等推理結束才填。maxTokens 太小時推理會把預算吃光，
        // 回來就是 content:"" + finish_reason:"length" —— 看起來像模型壞了，
        // 其實只是沒錢寫答案。明確辨識，否則整層會靜默失效。
        if (choice?.finish_reason === 'length' && choice?.message?.reasoning) {
          lastErr = new Error(
            `Together: ${model} 的推理耗盡 max_tokens(${maxTokens})，尚未產出答案。` +
              `推理模型請給更大的 maxTokens（建議 ≥1000），或改用非推理模型。`,
          )
          break
        }

        lastErr = new Error(`Together returned empty content on ${model}`)
        break
      } catch (err) {
        lastErr = err
        if (err?.name === 'AbortError') break // 逾時就換模型，不要繼續等
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
      } finally {
        clearTimeout(timer)
      }
    }
  }

  throw lastErr ?? new Error('Together: all models failed')
}
