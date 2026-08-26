// NVIDIA NIM adapter — FinOps 軌的「主力」供應商（2026-08-25 起，至 2027-02-25 重新評估）。
//
// 為什麼現階段把 NIM 排在 Together 前面：
//
//   1. 六個月免費／高額度期間（至 2027-02-25）。這段期間內能不花錢跑的
//      工作量，優先派給 NIM；Together／OpenRouter 退居 NIM 掛掉或
//      額度耗盡時的備援，成本結構跟平常沒有改變。
//   2. 2027-02-25 之後要重新評估 —— 屆時免費額度到期，這支 adapter
//      可能要退回備援位置。這裡刻意不寫死日期判斷邏輯（避免程式碼裡
//      藏一顆會在某天突然改變行為的定時彈），到期時手動調整
//      index.mjs 的供應鏈順序即可。
//
// API 形狀是 OpenAI 相容（/v1/chat/completions），所以刻意維持與
// together.mjs／openrouter.mjs 相同的匯出介面，router 不需要知道差別。

import { envInt, envList } from '../env.mjs'

const API_URL = process.env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1/chat/completions'
const MAX_ATTEMPTS = envInt('NIM_MAX_ATTEMPTS', 3)
const BACKOFF_BASE_MS = envInt('NIM_BACKOFF_BASE_MS', 100)
const REQUEST_TIMEOUT_MS = envInt('NIM_TIMEOUT_MS', 45_000)

/**
 * 三層模型，對齊 router.mjs 的 Tri-Tier：
 *   1 light    分類／抽取／JSON／清理 —— 便宜、量大
 *   2 standard 摘要／生成／比較／草稿／翻譯
 *   3 flagship 程式／分析／策略／推理／研究
 *
 * 跟 together.mjs 一樣不內建預設模型 ID —— NIM 目錄上的模型會變動，
 * 寫死清單過期時會變成「看似能跑但實際 404」。上線前用
 * build.nvidia.com 的 model card 逐一確認 slug 後填入。
 *
 * 設定方式：
 *   NIM_TIER1_MODELS=meta/llama-3.1-8b-instruct
 *   NIM_TIER2_MODELS=meta/llama-3.1-70b-instruct
 *   NIM_TIER3_MODELS=nvidia/nemotron-3-ultra-550b-a55b
 * 逗號分隔，依序當作 fallback 鏈：前一個失敗才換下一個。
 */
export const FINOPS_TIERS = {
  1: { name: 'light', models: envList('NIM_TIER1_MODELS', '') },
  2: { name: 'standard', models: envList('NIM_TIER2_MODELS', '') },
  3: { name: 'flagship', models: envList('NIM_TIER3_MODELS', '') },
}

export function listNimModels(tier) {
  const models = FINOPS_TIERS[tier]?.models
  if (!models?.length) {
    throw new Error(
      `NIM_TIER${tier}_MODELS 未設定。本套件不內建模型清單 —— ` +
        `請到 build.nvidia.com 確認 model slug 後填入（逗號分隔）。`,
    )
  }
  return models.slice()
}

/**
 * 每個模型的怪癖修正（2026-08-25 pvl-ja-drafts/bench/probe-nim.mjs 逐一實測）。
 *
 * 這一層存在的理由：**同一組參數套到所有模型會把好模型判死。**
 * 實測到的兩種怪癖：
 *
 *   minTokens  推理模型會先把預算燒在思考上才開始寫答案。給小了不會報錯，
 *              只會回 content:"" + finish_reason:'length' —— 看起來像模型壞了。
 *              nvidia-nemotron-nano-9b-v2 實測 @200 空回、@2000 才答得出來。
 *
 *   body       Nemotron 3 系列可用 chat_template_kwargs.enable_thinking 關掉思考。
 *              ⚠️ 不是全系列都吃：nemotron-3-nano-30b-a3b 有效（15 tok/283ms），
 *              nvidia-nemotron-nano-9b-v2 無效（仍然思考）。所以是逐一列舉，
 *              不是靠模型名稱前綴猜——比照 Studio 踩過的 Seedance resolution 靜默降級。
 *
 * ⚠️ 只列「實測驗證過」的。沒測過的模型不要憑感覺加進來，那會變成另一種
 * 「看似能跑但實際壞掉」的預設值。
 */
export const MODEL_QUIRKS = {
  'nvidia/nvidia-nemotron-nano-9b-v2': { minTokens: 2000 },
  'nvidia/nemotron-3-nano-30b-a3b': {
    body: { chat_template_kwargs: { enable_thinking: false } },
  },
  // 2026-08-26 正式環境抓到：呼叫端給 maxTokens=400 時，推理把預算吃光，
  // 回來是截斷內容，整個 tier3 降級到 Together。bench 當時用 8000 跑得通
  // （平均 completion_tokens 2058，含推理），所以下限抓 4000 留餘裕。
  // 注意這顆在 Together 上同樣的 400 預算卻能正常回答 —— 同一個模型 ID
  // 在不同供應商的行為不同，這正是「不要跨供應商套用實測結論」的實例。
  'nvidia/nemotron-3-ultra-550b-a55b': { minTokens: 4000 },
}

export function nimTierName(tier) {
  return FINOPS_TIERS[tier]?.name || `tier${tier}`
}

export function isNimConfigured() {
  return Boolean(process.env.NVIDIA_NIM_API_KEY)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 呼叫 NIM 的 chat completions。
 *
 * 逐一嘗試 models 陣列裡的模型：某個模型 404／限流就換下一個，
 * 全部失敗才丟出 —— 與 together.mjs／openrouter.mjs 行為一致，讓 router 可以互換。
 */
export async function callNim({ models, system, messages, maxTokens, json }) {
  // .trim()：.env 貼值常見尾隨空白，直接送進 Authorization header 會產生
  // 「看起來對但實際 401」的錯誤，訊息不會告訴你是空白搞的鬼。
  const key = process.env.NVIDIA_NIM_API_KEY?.trim()
  if (!key) throw new Error('NVIDIA_NIM_API_KEY missing')

  const payload = (model) => {
    const quirks = MODEL_QUIRKS[model] ?? {}
    // 只拉高、不壓低：呼叫端要給更大的預算是它的自由，這裡只保證不低於
    // 該模型「寫得出答案」的實測下限。
    const effectiveMaxTokens = Math.max(maxTokens, quirks.minTokens ?? 0)
    return {
      model,
      messages: [
        // system 可能是字串或 cache_control 區塊陣列（buildCachedSystem 產生）。
        // NIM 不支援 Anthropic 的 cache_control，收到陣列時攤平成純文字，
        // 否則 API 會 400。
        ...(system
          ? [{ role: 'system', content: Array.isArray(system) ? system.map((b) => b.text ?? '').join('\n\n') : system }]
          : []),
        ...messages,
      ],
      max_tokens: effectiveMaxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...(quirks.body ?? {}),
    }
  }

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
          lastErr = new Error(`NIM ${res.status} on ${model}`)
          await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
          continue
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          lastErr = new Error(`NIM ${res.status} on ${model}: ${body.slice(0, 160)}`)
          break
        }

        const jsonBody = await res.json()
        const choice = jsonBody?.choices?.[0]
        const text = choice?.message?.content

        const sentMaxTokens = Math.max(maxTokens, MODEL_QUIRKS[model]?.minTokens ?? 0)

        if (typeof text === 'string' && text.length) {
          // ⚠️ 撞到 length 上限的輸出是被截斷的，不能當成成功回傳。
          // 有些推理模型把思考寫進 content（不是 message.reasoning），下面那道
          // reasoning 判斷接不到，於是一段沒寫完的思考會被當答案送回呼叫端。
          // bench 實測遇過：拿到的是英文思考過程，相似度 0.07。
          if (choice?.finish_reason === 'length') {
            lastErr = new Error(
              `NIM: ${model} 的輸出撞上 max_tokens(${sentMaxTokens}) 被截斷。` +
                `截斷的內容不予採用——請加大 maxTokens，或改用非推理模型。`,
            )
            break
          }
          return {
            text,
            model,
            provider: 'nim',
            usage: jsonBody.usage ?? null,
            ...(choice?.message?.reasoning ? { reasoning: choice.message.reasoning } : {}),
          }
        }

        // 推理模型（如 nemotron-3-ultra）把思考放在 message.reasoning，
        // content 要等推理結束才填。maxTokens 太小會被推理吃光預算。
        if (choice?.finish_reason === 'length' && choice?.message?.reasoning) {
          lastErr = new Error(
            `NIM: ${model} 的推理耗盡 max_tokens(${sentMaxTokens})，尚未產出答案。` +
              `推理模型請給更大的 maxTokens（建議 ≥2000），或在 MODEL_QUIRKS 補上 minTokens。`,
          )
          break
        }

        lastErr = new Error(`NIM returned empty content on ${model}`)
        break
      } catch (err) {
        lastErr = err
        if (err?.name === 'AbortError') break
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
      } finally {
        clearTimeout(timer)
      }
    }
  }

  throw lastErr ?? new Error('NIM: all models failed')
}
