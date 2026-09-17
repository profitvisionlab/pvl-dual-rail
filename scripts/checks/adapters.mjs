// DeepInfra／Lightning adapter 離線檢查：成功、限流、壞金鑰、cached tokens、base URL。

import { withEnv, withFetch, completion } from './mock.mjs'
import { callDeepInfra } from '../../src/adapters/deepinfra.mjs'
import { callLightning } from '../../src/adapters/lightning.mjs'

const MSG = [{ role: 'user', content: 'ping' }]

async function adapterChecks(ok, { name, call, keyEnv, baseEnv, expectedUrl, overrideBase, overrideUrl, usageOk, cachedOk }) {
  // 成功
  {
    const { calls, result, error } = await withEnv({ [keyEnv]: 'sk-test_123' }, () =>
      withFetch(() => ({ body: completion({ content: 'pong', usage: usageOk }) }), () =>
        call({ models: ['m-a'], system: [{ text: 'sys', cache_control: { type: 'ephemeral' } }], messages: MSG, maxTokens: 32 })))
    ok(`${name}: 成功回傳 text／provider／旗標`,
      !error && result.text === 'pong' && result.provider === name && result.model === 'm-a' &&
        result.finishReason === 'stop' && result.truncated === false && result.reasoningExhausted === false &&
        Array.isArray(result.toolCalls) && result.toolCalls.length === 0 && result.message?.role === 'assistant',
      error?.message || '')
    ok(`${name}: 預設端點與 Bearer 標頭`,
      calls[0]?.url === expectedUrl && calls[0]?.headers?.Authorization === 'Bearer sk-test_123', calls[0]?.url)
    ok(`${name}: system 陣列攤平、未帶 tools`,
      calls[0]?.body?.messages?.[0]?.content === 'sys' && !('tools' in (calls[0]?.body || {})) && calls[0]?.body?.max_tokens === 32)
    ok(`${name}: cachedTokens ${cachedOk === null ? '容忍 null' : `= ${cachedOk}`}`, result?.cachedTokens === cachedOk, String(result?.cachedTokens))
  }
  // usage 整個是 null 也不能炸
  {
    const { result, error } = await withEnv({ [keyEnv]: 'k' }, () =>
      withFetch(() => ({ body: completion({ content: 'pong', usage: null }) }), () => call({ models: ['m'], messages: MSG, maxTokens: 8 })))
    ok(`${name}: usage=null → cachedTokens null`, !error && result.cachedTokens === null && result.usage === null, error?.message || '')
  }
  // base URL 覆寫（尾斜線也接受）
  {
    const { calls } = await withEnv({ [keyEnv]: 'k', [baseEnv]: overrideBase }, () =>
      withFetch(() => ({ body: completion() }), () => call({ models: ['m'], messages: MSG, maxTokens: 8 })))
    ok(`${name}: ${baseEnv} 覆寫`, calls[0]?.url === overrideUrl, calls[0]?.url)
  }
  // 限流一次後成功（重試同一模型）
  {
    const { calls, result, error } = await withEnv({ [keyEnv]: 'k' }, () =>
      withFetch((c) => (c.n === 1 ? { status: 429, body: 'slow down' } : { body: completion({ content: 'after-retry' }) }),
        () => call({ models: ['m1'], messages: MSG, maxTokens: 8 })))
    ok(`${name}: 429 後重試成功`, !error && result.text === 'after-retry' && calls.length === 2, `calls=${calls.length}`)
  }
  // 限流用盡 → 換模型 → 全部失敗丟出
  {
    const { calls, error } = await withEnv({ [keyEnv]: 'k' }, () =>
      withFetch(() => ({ status: 429, body: 'slow down' }), () => call({ models: ['m1', 'm2'], messages: MSG, maxTokens: 8 })))
    ok(`${name}: 429 用盡 → 丟錯（每模型 2 次）`, error?.status === 429 && calls.length === 4 && calls[3].body.model === 'm2', error?.message)
  }
  // 壞金鑰：401 不換模型、直接丟
  {
    const { calls, error } = await withEnv({ [keyEnv]: 'k' }, () =>
      withFetch(() => ({ status: 401, body: '{"error":"invalid key"}' }), () => call({ models: ['m1', 'm2'], messages: MSG, maxTokens: 8 })))
    ok(`${name}: 401 → DUAL_RAIL_KEY_REJECTED 且只打一次`, error?.code === 'DUAL_RAIL_KEY_REJECTED' && calls.length === 1, error?.message)
  }
  // 壞金鑰：非 ASCII 在發請求前就擋
  {
    const { calls, error } = await withEnv({ [keyEnv]: 'sk-壞' }, () =>
      withFetch(() => ({ body: completion() }), () => call({ models: ['m1'], messages: MSG, maxTokens: 8 })))
    ok(`${name}: 非 ASCII 金鑰 → DUAL_RAIL_BAD_KEY、零請求`, error?.code === 'DUAL_RAIL_BAD_KEY' && calls.length === 0, error?.message)
  }
  // 沒金鑰
  {
    const { calls, error } = await withEnv({}, () =>
      withFetch(() => ({ body: completion() }), () => call({ models: ['m1'], messages: MSG, maxTokens: 8 })))
    ok(`${name}: 未設 ${keyEnv} → 丟錯、零請求`, /missing/.test(error?.message || '') && calls.length === 0, error?.message)
  }
}

export async function runAdapterChecks(ok) {
  await adapterChecks(ok, {
    name: 'deepinfra', call: callDeepInfra, keyEnv: 'DEEPINFRA_API_KEY', baseEnv: 'DEEPINFRA_BASE_URL',
    expectedUrl: 'https://api.deepinfra.com/v1/openai/chat/completions',
    overrideBase: 'https://proxy.example/v1/openai/', overrideUrl: 'https://proxy.example/v1/openai/chat/completions',
    usageOk: { prompt_tokens: 1200, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1024 } }, cachedOk: 1024,
  })
  await adapterChecks(ok, {
    name: 'lightning', call: callLightning, keyEnv: 'LIGHTNING_API_KEY', baseEnv: 'LIGHTNING_BASE_URL',
    expectedUrl: 'https://lightning.ai/api/v1/chat/completions',
    overrideBase: 'https://lightning.example/api/v1/chat/completions', overrideUrl: 'https://lightning.example/api/v1/chat/completions',
    usageOk: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: null }, cachedOk: null,
  })
  await gatewayChecks(ok)
  await reasoningFieldChecks(ok)
}

// DeepInfra 的推理欄位叫 reasoning_content（2026-09-17 Qwen3.5-397B 跑分時實際回應）
async function reasoningFieldChecks(ok) {
  const exhausted = { choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'thinking '.repeat(50) }, finish_reason: 'length' }], usage: { prompt_tokens: 43, completion_tokens: 2000 } }
  {
    const { error } = await withEnv({ DEEPINFRA_API_KEY: 'sk-test_123' }, () =>
      withFetch(() => ({ body: exhausted }), () => callDeepInfra({ models: ['Qwen/Qwen3.5-397B-A17B'], messages: MSG, maxTokens: 2000 })))
    ok('deepinfra: reasoning_content 吃光額度 → DUAL_RAIL_REASONING_EXHAUSTED（不是「空內容」）',
      error?.code === 'DUAL_RAIL_REASONING_EXHAUSTED', `code=${error?.code} msg=${error?.message}`)
  }
  {
    const body = { choices: [{ message: { role: 'assistant', content: 'カートに入れる', reasoning_content: 'short thought' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    const { result } = await withEnv({ DEEPINFRA_API_KEY: 'sk-test_123' }, () =>
      withFetch(() => ({ body }), () => callDeepInfra({ models: ['m'], messages: MSG, maxTokens: 64 })))
    ok('deepinfra: reasoning_content 帶到 result.reasoning', result?.reasoning === 'short thought' && result?.text === 'カートに入れる', JSON.stringify(result?.reasoning))
  }
  {
    const body = { choices: [{ message: { role: 'assistant', content: 'ok', reasoning: 'r' }, finish_reason: 'stop' }] }
    const { result } = await withEnv({ LIGHTNING_API_KEY: 'sk-test_123' }, () =>
      withFetch(() => ({ body }), () => callLightning({ models: ['m'], messages: MSG, maxTokens: 64 })))
    ok('lightning: 既有 reasoning 欄位照舊', result?.reasoning === 'r', JSON.stringify(result?.reasoning))
  }
}

// 2026-09-17 真金鑰實測踩到的閘道行為，固化成離線測試。
const TOOLS = [{ type: 'function', function: { name: 'get_store_hours', parameters: { type: 'object', properties: {} } } }]
const LIGHT = { LIGHTNING_API_KEY: 'sk-test_123', LIGHTNING_MAX_ATTEMPTS: '3' }

async function gatewayChecks(ok) {
  // OpenAI 推理世代走 max_completion_tokens，其他模型維持 max_tokens
  {
    const { calls } = await withEnv(LIGHT, () =>
      withFetch(() => ({ body: completion() }), async () => {
        await callLightning({ models: ['openai/gpt-5.5-2026-04-23'], messages: MSG, maxTokens: 64 })
        await callLightning({ models: ['openai/gpt-4.1'], messages: MSG, maxTokens: 64 })
        await callLightning({ models: ['google/gemini-2.5-flash'], messages: MSG, maxTokens: 64 })
      }))
    const [gpt5, gpt41, gem] = calls.map((c) => c.body)
    ok('lightning: gpt-5.5 送 max_completion_tokens、不送 max_tokens',
      gpt5?.max_completion_tokens === 64 && !('max_tokens' in gpt5), JSON.stringify(gpt5))
    ok('lightning: gpt-4.1／gemini 維持 max_tokens',
      gpt41?.max_tokens === 64 && gem?.max_tokens === 64 && !('max_completion_tokens' in gpt41), JSON.stringify([gpt41, gem]))
  }
  // DeepInfra 不受影響
  {
    const { calls } = await withEnv({ DEEPINFRA_API_KEY: 'sk-test_123' }, () =>
      withFetch(() => ({ body: completion() }), () => callDeepInfra({ models: ['openai/gpt-5-like'], messages: MSG, maxTokens: 64 })))
    ok('deepinfra: 一律 max_tokens', calls[0]?.body?.max_tokens === 64, JSON.stringify(calls[0]?.body))
  }
  // 閘道把上游 400 包成 500：不重試、換下一個模型、錯誤訊息帶 body
  {
    const body = 'error, status code: 400, status: 400 Bad Request, message: something upstream rejected'
    const { calls, result, error } = await withEnv(LIGHT, () =>
      withFetch((c) => (c.body.model === 'bad' ? { status: 500, body } : { body: completion({ content: 'fine' }) }),
        () => callLightning({ models: ['bad', 'good'], messages: MSG, maxTokens: 8 })))
    const badCalls = calls.filter((c) => c.body.model === 'bad').length
    ok('lightning: 包裝過的上游 400 不重試（bad 只打 1 次）並換到下一個模型',
      badCalls === 1 && result?.text === 'fine', `bad=${badCalls} err=${error?.message}`)
  }
  // 真正的 5xx 仍重試，且訊息帶 body
  {
    const { calls, error } = await withEnv(LIGHT, () =>
      withFetch(() => ({ status: 503, body: 'The model is temporarily unavailable.' }),
        () => callLightning({ models: ['anthropic/claude-sonnet-5'], messages: MSG, maxTokens: 8 })))
    ok('lightning: 503 仍依 MAX_ATTEMPTS 重試 3 次', calls.length === 3, `calls=${calls.length}`)
    ok('lightning: 錯誤訊息帶出上游原因', /temporarily unavailable/.test(error?.message || ''), error?.message)
  }
  // 模型×通道不支援工具：Gemini thought_signature 與 GPT-5.5 reasoning+tools
  for (const [label, body] of [
    ['gemini thought_signature', 'status code: 400 ... function call `get_store_hours` in the 2. content block is missing a `thought_signature`'],
    ['gpt-5.5 reasoning+tools', 'status code: 400 ... Function tools with reasoning_effort are not supported for gpt-5.5-2026-04-23'],
  ]) {
    const { calls, error } = await withEnv(LIGHT, () =>
      withFetch(() => ({ status: 500, body }), () => callLightning({ models: ['m'], messages: MSG, maxTokens: 8, tools: TOOLS })))
    ok(`lightning: ${label} → DUAL_RAIL_TOOLS_UNSUPPORTED、不重試`,
      error?.code === 'DUAL_RAIL_TOOLS_UNSUPPORTED' && calls.length === 1, `code=${error?.code} calls=${calls.length}`)
  }
  // 沒帶工具時同樣字樣不標成工具不支援
  {
    const { error } = await withEnv(LIGHT, () =>
      withFetch(() => ({ status: 400, body: 'missing a `thought_signature`' }), () => callLightning({ models: ['m'], messages: MSG, maxTokens: 8 })))
    ok('lightning: 無 tools 時不標 DUAL_RAIL_TOOLS_UNSUPPORTED', error && error.code !== 'DUAL_RAIL_TOOLS_UNSUPPORTED', `code=${error?.code}`)
  }
}
