// OpenAI 相容 chat completions 的共用核心（0.3.0，2026-09-17）。
//
// Together／DeepInfra／Lightning 三家都是 /chat/completions 形狀，差別只在
// 端點、金鑰名稱、env 前綴。以前每接一家就複製一份 together.mjs，三份迴圈
// 各自漂移（重試、截斷辨識、推理耗盡）遲早會不一致——C1 的旗標就是在
// 「每家各自解讀 finish_reason」這個坑裡踩了四次才統一的。
// 所以迴圈只寫一次，各 adapter 只宣告自己的設定。
//
// OpenRouter 不走這裡：它有 models[]＋route:fallback＋provider 偏好，形狀不同；
// 但它共用本檔的訊息／工具／usage 輔助函式，確保四家回傳形狀一致。
//
// 設定一律「呼叫當下」讀 env，不在載入時快照：
//   · 測試可以逐案切換金鑰與模型清單，不必重新 import
//   · 長駐程序改 env 後不用重啟就生效（金鑰輪替時有用）

import { envInt, envList, assertAsciiKey, finishFlags } from '../env.mjs'
import { buildResponsesBody, parseResponsesResult, responsesUrl } from './responses.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 供 README 與錯誤訊息引用的三層名稱，對齊 router.mjs 的 Tri-Tier。 */
export const TIER_NAMES = { 1: 'light', 2: 'standard', 3: 'flagship' }

/**
 * system 可能是字串或 cache_control 區塊陣列（buildCachedSystem 產生）。
 * 非 Anthropic 端點不認 cache_control，收到陣列時攤平成純文字，否則會 400。
 */
export function flattenSystem(system) {
  if (system == null || system === '') return null
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n\n')
  return String(system)
}

/**
 * 工具欄位原樣透傳（OpenAI function 格式）。沒給就完全不帶，
 * 避免對不支援工具的模型送出空的 tools:[] 而被 400。
 */
export function toolFields({ tools, toolChoice } = {}) {
  const out = {}
  if (Array.isArray(tools) && tools.length) out.tools = tools
  if (toolChoice != null && out.tools) out.tool_choice = toolChoice
  return out
}

/**
 * 把 assistant 訊息裡的 tool_calls 正規化為 [{id, name, arguments}]。
 * arguments 一律是字串：OpenAI 規格是 JSON 字串，但有些相容端點回物件——
 * 呼叫端若要 JSON.parse，形狀不一致就會在某一家靜默壞掉。
 */
export function normalizeToolCalls(message) {
  const calls = message?.tool_calls
  if (!Array.isArray(calls)) return []
  return calls.map((tc) => {
    const args = tc?.function?.arguments
    return {
      id: tc?.id ?? null,
      name: tc?.function?.name ?? null,
      arguments: typeof args === 'string' ? args : args == null ? '' : JSON.stringify(args),
    }
  })
}

/**
 * 推理內容的欄位名各家不同：OpenRouter／Together 用 `reasoning`，
 * DeepInfra（Qwen3.5、Kimi-K3 等）用 `reasoning_content`。
 * 只認一種時，DeepInfra 的推理耗盡會被誤報成「空內容」——2026-09-17 跑分時踩到。
 */
export function reasoningOf(message) {
  const r = message?.reasoning ?? message?.reasoning_content
  return typeof r === 'string' && r.length ? r : null
}

/**
 * usage 裡的快取命中 token 數。DeepInfra／OpenAI 放在 prompt_tokens_details.cached_tokens；
 * Lightning 的 prompt_tokens_details 可能是 null，usage 本身也可能是 null——都回 null，不丟錯。
 * null 的意思是「供應商沒報」，不是「零命中」，兩者在成本分析上要分開看。
 */
export function cachedTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  const v = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? usage.cachedContentTokenCount
  return Number.isFinite(v) ? v : null
}

/** base URL 或完整 URL 都接受：已經指到 /chat/completions 就原樣用。 */
export function chatCompletionsUrl(base) {
  const trimmed = String(base).replace(/\/+$/, '')
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

/**
 * 閘道把上游的 4xx 包成 5xx 回來（2026-09-17 Lightning 實測：Google／OpenAI 的 400
 * 被包成 HTTP 500，body 寫 `status code: 400`）。這種錯重試幾次都一樣，只會燒時間，
 * 要當不可重試、直接換下一個模型。
 */
const WRAPPED_CLIENT_ERROR = /status code:\s*4\d\d|\bBad Request\b|INVALID_ARGUMENT/i

/**
 * 「這個模型在這條通道上不能用工具」的錯誤特徵（2026-09-17 Lightning 實測）：
 * · Gemini 3／3.5：閘道沒把 thought_signature 傳回來，回填 tool 結果那一輪必 400
 * · GPT-5.5：閘道強制帶 reasoning_effort，OpenAI 拒絕 reasoning＋function tools
 * 命中時丟 DUAL_RAIL_TOOLS_UNSUPPORTED，讓呼叫端知道是「組合不支援」而不是「暫時故障」。
 */
const TOOLS_UNSUPPORTED = /thought_signature|Function tools with reasoning_effort|tools? (?:are |is )?not supported|does not support (?:tools|function)|does not support the Responses API/i

function httpError({ label, status, model, body, tools }) {
  const snippet = String(body || '').replace(/\s+/g, ' ').slice(0, 240)
  const err = new Error(`${label} ${status} on ${model}${snippet ? `: ${snippet}` : ''}`)
  err.status = status
  if (tools && TOOLS_UNSUPPORTED.test(snippet)) err.code = 'DUAL_RAIL_TOOLS_UNSUPPORTED'
  return err
}

/**
 * 建立一個 OpenAI 相容 adapter。
 *
 * @param {object} spec
 * @param {string} spec.id           - chain 內的名稱（together／deepinfra／lightning）
 * @param {string} spec.label        - 錯誤訊息用的顯示名
 * @param {string} spec.envPrefix    - env 前綴（TOGETHER → TOGETHER_API_KEY、TOGETHER_TIER1_MODELS…）
 * @param {string} spec.defaultBaseUrl
 * @param {string} [spec.docHint]    - 模型清單未設定時，錯誤訊息指向哪份說明
 * @param {(model: string) => string} [spec.maxTokensField]
 *   - 上限欄位名。預設 max_tokens；OpenAI 推理世代（gpt-5／gpt-6／o 系列）只收 max_completion_tokens
 * @param {(model: string, ctx: { tools?: object[] }) => boolean} [spec.useResponses]
 *   - 這次呼叫改走 /responses（0.4.0）。預設一律走 /chat/completions。
 *     格式轉換在 responses.mjs，呼叫端的輸入輸出形狀不變。
 */
export function createOpenAICompatAdapter({ id, label, envPrefix, defaultBaseUrl, docHint, maxTokensField = () => 'max_tokens', useResponses = () => false }) {
  const keyEnv = `${envPrefix}_API_KEY`
  const tierEnv = (tier) => `${envPrefix}_TIER${tier}_MODELS`

  const config = () => ({
    url: chatCompletionsUrl(process.env[`${envPrefix}_BASE_URL`] || defaultBaseUrl),
    respUrl: responsesUrl(process.env[`${envPrefix}_BASE_URL`] || defaultBaseUrl),
    maxAttempts: Math.max(1, envInt(`${envPrefix}_MAX_ATTEMPTS`, 3)),
    backoffBaseMs: envInt(`${envPrefix}_BACKOFF_BASE_MS`, 100),
    timeoutMs: envInt(`${envPrefix}_TIMEOUT_MS`, 45_000),
  })

  function listModels(tier) {
    const models = envList(tierEnv(tier), '')
    // 空清單會讓 runTier 拿到零個模型後靜默跳過整層，看起來像「這層沒失敗」。
    // 寧可在這裡明確炸掉，訊息直接指出要設哪個環境變數。
    if (!models.length) {
      throw new Error(
        `${tierEnv(tier)} 未設定。本套件不內建模型清單 —— ` +
          `供應商目錄變動快，寫死的預設過期時會變成「看似能跑但實際 400」。` +
          `請依 ${docHint || 'adapters/together.mjs 檔頭'}的挑選方法論自行實測後填入（逗號分隔）。`,
      )
    }
    return models
  }

  const tierName = (tier) => TIER_NAMES[tier] || `tier${tier}`
  const isConfigured = () => Boolean(process.env[keyEnv])

  /**
   * 逐一嘗試 models：某個模型 404／限流用盡就換下一個，全部失敗才丟出。
   * 401／403 是金鑰層級問題，換模型也不會好 —— 直接丟出，不燒剩下的模型。
   */
  async function call({ models, system, messages, maxTokens, json, tools, toolChoice }) {
    const key = assertAsciiKey(keyEnv, process.env[keyEnv])
    const { url, respUrl, maxAttempts, backoffBaseMs, timeoutMs } = config()
    const sys = flattenSystem(system)

    const payload = (model) => ({
      model,
      messages: [...(sys != null ? [{ role: 'system', content: sys }] : []), ...(messages || [])],
      [maxTokensField(model)]: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...toolFields({ tools, toolChoice }),
    })

    let lastErr = null

    for (const model of models) {
      const viaResponses = Boolean(useResponses(model, { tools }))
      const body = JSON.stringify(
        viaResponses ? buildResponsesBody({ model, system: sys, messages, maxTokens, json, tools, toolChoice }) : payload(model),
      )
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), timeoutMs)
        try {
          const res = await fetch(viaResponses ? respUrl : url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body,
            signal: ctl.signal,
          })

          if (res.status === 429 || res.status >= 500) {
            // 可重試：限流或對方伺服器問題（DeepInfra fail_fast 容量滿也回 429）。
            // body 一定要帶進錯誤訊息——只寫「500 on model」時，模型不支援、閘道故障、
            // 參數錯三種完全不同的原因看起來一模一樣（2026-09-17 實測踩到）。
            const body = await res.text().catch(() => '')
            lastErr = httpError({ label, status: res.status, model, body, tools })
            if (lastErr.code === 'DUAL_RAIL_TOOLS_UNSUPPORTED' || WRAPPED_CLIENT_ERROR.test(body)) break
            if (attempt < maxAttempts) await sleep(backoffBaseMs * 2 ** (attempt - 1))
            continue
          }
          if (res.status === 401 || res.status === 403) {
            const body = await res.text().catch(() => '')
            const err = new Error(`${label} ${res.status}（${keyEnv} 被拒，換模型無效）: ${body.slice(0, 160)}`)
            err.status = res.status
            err.code = 'DUAL_RAIL_KEY_REJECTED'
            err.fatal = true
            throw err
          }
          if (!res.ok) {
            // 不可重試（400/404…）→ 換下一個模型
            const body = await res.text().catch(() => '')
            lastErr = httpError({ label, status: res.status, model, body, tools })
            break
          }

          const jsonBody = await res.json()
          let parsed
          if (viaResponses) {
            parsed = parseResponsesResult(jsonBody)
          } else {
            const choice = jsonBody?.choices?.[0]
            const message = choice?.message ?? null
            parsed = {
              text: typeof message?.content === 'string' ? message.content : '',
              toolCalls: normalizeToolCalls(message),
              message,
              usage: jsonBody?.usage ?? null,
              finishReason: choice?.finish_reason,
              hasReasoning: Boolean(reasoningOf(message)),
              reasoning: reasoningOf(message),
              model: jsonBody?.model ?? null,
            }
          }
          const { text, toolCalls, message, usage } = parsed

          if (text.length || toolCalls.length) {
            // 有內容但撞 length＝被截斷：不丟錯，回傳並打 truncated 旗標，由 router／呼叫端決定。
            // 只有 tool_calls、沒有文字也算有效回覆（finish_reason=tool_calls 不算截斷）。
            return {
              text,
              model: parsed.model || model,
              provider: id,
              api: viaResponses ? 'responses' : 'chat',
              usage,
              cachedTokens: cachedTokensOf(usage),
              toolCalls,
              message,
              ...finishFlags(parsed.finishReason, { hasContent: true, hasReasoning: parsed.hasReasoning }),
              ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
            }
          }

          // ⚠️ 推理模型把思考放在 message.reasoning（或 reasoning_content、Responses 的 reasoning item），
          // content 要等推理結束才填。maxTokens 太小時回來就是空內容＋length ——
          // 看起來像模型壞了，其實只是沒錢寫答案。明確辨識，否則整層會靜默失效。
          if (parsed.finishReason === 'length' && parsed.hasReasoning) {
            lastErr = new Error(
              `${label}: ${model} 的推理耗盡 max_tokens(${maxTokens})，尚未產出答案。` +
                `推理模型請給更大的 maxTokens（建議 ≥1000），或改用非推理模型。`,
            )
            lastErr.code = 'DUAL_RAIL_REASONING_EXHAUSTED'
            break
          }

          lastErr = new Error(`${label} returned empty content on ${model}`)
          break
        } catch (err) {
          if (err?.fatal) throw err
          lastErr = err
          if (err?.name === 'AbortError') break // 逾時就換模型，不要繼續等
          if (attempt < maxAttempts) await sleep(backoffBaseMs * 2 ** (attempt - 1))
        } finally {
          clearTimeout(timer)
        }
      }
    }

    throw lastErr ?? new Error(`${label}: all models failed`)
  }

  return { id, label, keyEnv, listModels, tierName, isConfigured, call }
}
