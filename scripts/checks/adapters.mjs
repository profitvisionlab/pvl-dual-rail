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
}
