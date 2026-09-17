// 離線測試輔助：暫時替換 env 與 globalThis.fetch，結束後原樣還原。
// 不打網路、不需要真金鑰；就算本機 .env 有真金鑰，測試期間也會被清掉。

const PROVIDER_ENV = [
  'DUAL_RAIL_FINOPS_CHAIN', 'DUAL_RAIL_FORCE_TIER',
  'TOGETHER_API_KEY', 'DEEPINFRA_API_KEY', 'LIGHTNING_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  'TOGETHER_BASE_URL', 'DEEPINFRA_BASE_URL', 'LIGHTNING_BASE_URL', 'OPENAI_BASE_URL', 'LIGHTNING_RESPONSES',
  ...['TOGETHER', 'DEEPINFRA', 'LIGHTNING', 'OPENAI'].flatMap((p) => [1, 2, 3].map((t) => `${p}_TIER${t}_MODELS`)),
]

/** 以乾淨的供應商 env 執行 fn；vars 裡值為 undefined 代表刪除。 */
export async function withEnv(vars, fn) {
  const keys = new Set([...PROVIDER_ENV, ...Object.keys(vars),
    'TOGETHER_BACKOFF_BASE_MS', 'DEEPINFRA_BACKOFF_BASE_MS', 'LIGHTNING_BACKOFF_BASE_MS', 'OPENAI_BACKOFF_BASE_MS',
    'TOGETHER_MAX_ATTEMPTS', 'DEEPINFRA_MAX_ATTEMPTS', 'LIGHTNING_MAX_ATTEMPTS', 'OPENAI_MAX_ATTEMPTS'])
  const saved = {}
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k] }
  const all = {
    TOGETHER_BACKOFF_BASE_MS: '0', DEEPINFRA_BACKOFF_BASE_MS: '0', LIGHTNING_BACKOFF_BASE_MS: '0', OPENAI_BACKOFF_BASE_MS: '0',
    TOGETHER_MAX_ATTEMPTS: '2', DEEPINFRA_MAX_ATTEMPTS: '2', LIGHTNING_MAX_ATTEMPTS: '2', OPENAI_MAX_ATTEMPTS: '2',
    ...vars,
  }
  for (const [k, v] of Object.entries(all)) if (v !== undefined) process.env[k] = v
  try { return await fn() } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

/**
 * 以 handler 取代 fetch。handler(call) 回 { status, body }；call = { url, headers, body(已 parse), n }。
 * 回傳 { calls, result }，calls 記錄每一次請求。
 */
export async function withFetch(handler, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null, n: calls.length + 1 }
    calls.push(call)
    const { status = 200, body = {} } = (await handler(call)) || {}
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const result = await fn()
    return { calls, result }
  } catch (error) {
    return { calls, error }
  } finally {
    globalThis.fetch = original
  }
}

/** OpenAI 形狀的成功回覆。 */
export function completion({ content = 'ok', finish = 'stop', toolCalls, usage = { prompt_tokens: 10, completion_tokens: 2 }, model } = {}) {
  return {
    ...(model ? { model } : {}),
    choices: [{
      message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: finish,
    }],
    usage,
  }
}

export const LONG = 'This reply is intentionally longer than forty characters to pass.'
