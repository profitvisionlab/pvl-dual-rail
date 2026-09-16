// FinOps chain 順序／跳過、政策閘門不受 chain 與 tools 影響、工具呼叫透傳與正規化。

import { withEnv, withFetch, completion, LONG } from './mock.mjs'
import { chatComplete, resetCircuitBreakers, resolveFinopsChain } from '../../src/index.mjs'
import { finishFlags } from '../../src/env.mjs'
import { callTogether } from '../../src/adapters/together.mjs'
import { callDeepInfra } from '../../src/adapters/deepinfra.mjs'
import { callLightning } from '../../src/adapters/lightning.mjs'
import { callOpenRouter } from '../../src/adapters/openrouter.mjs'

const MSG = [{ role: 'user', content: 'ping' }]
const host = (url) => new URL(url).hostname
const code = (fn) => { try { fn(); return null } catch (e) { return e.code } }

const TOOLS = [{
  type: 'function',
  function: { name: 'get_weather', description: 'Weather by city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
}]
const TOOL_CALL_REPLY = completion({
  content: null,
  finish: 'tool_calls',
  toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Taipei"}' } }],
})
// 回填第二輪：assistant(tool_calls) + tool 結果
const TOOL_ROUND_2 = [
  { role: 'user', content: 'Weather in Taipei?' },
  TOOL_CALL_REPLY.choices[0].message,
  { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":31}' },
]

async function chainChecks(ok) {
  ok('chain: 未設定 → 預設 together,openrouter', (await withEnv({}, () => resolveFinopsChain())).join(',') === 'together,openrouter')
  ok('chain: 大小寫／空白／重複正規化', resolveFinopsChain(' DeepInfra, lightning ,deepinfra').join(',') === 'deepinfra,lightning')
  ok('chain: 不認得的名字 → DUAL_RAIL_BAD_CHAIN', code(() => resolveFinopsChain('together,nim')) === 'DUAL_RAIL_BAD_CHAIN')
  ok('chain: 只有逗號 → DUAL_RAIL_BAD_CHAIN', code(() => resolveFinopsChain(',')) === 'DUAL_RAIL_BAD_CHAIN')

  const cfg = {
    DUAL_RAIL_FINOPS_CHAIN: 'together,deepinfra,lightning,openrouter',
    DEEPINFRA_API_KEY: 'di', DEEPINFRA_TIER1_MODELS: 'deepseek-ai/DeepSeek-V4-Flash',
    LIGHTNING_API_KEY: 'lt', LIGHTNING_TIER1_MODELS: 'lightning-ai/deepseek-v4-pro',
  }

  // 未設金鑰的 together／openrouter 跳過並記在 attempts，deepinfra 接手，不算降級
  resetCircuitBreakers()
  {
    const { calls, result, error } = await withEnv(cfg, () =>
      withFetch(() => ({ body: completion({ content: LONG }) }), () =>
        chatComplete({ messages: MSG, sensitivity: 'public', tier: 1, escalate: false })))
    ok('chain: 跳過未設金鑰者，第一個有金鑰的接手',
      !error && result.provider === 'deepinfra-tier1' && calls.length === 1 && host(calls[0].url) === 'api.deepinfra.com' &&
        !result.fellBack && result.skippedProviders?.join(',') === 'together',
      error?.message || result?.provider)
    ok('chain: attempts 記錄 skipped 供應商與 envVar',
      result?.attempts?.[0]?.provider === 'together' && result.attempts[0].skipped === 'not-configured' &&
        result.attempts[0].envVar === 'TOGETHER_API_KEY' && result.finopsChain?.length === 4,
      JSON.stringify(result?.attempts))
  }

  // deepinfra 5xx → lightning 接手，標 fellBack，順序正確
  resetCircuitBreakers()
  {
    const { calls, result, error } = await withEnv(cfg, () =>
      withFetch((c) => (host(c.url) === 'api.deepinfra.com' ? { status: 503, body: 'down' } : { body: completion({ content: LONG }) }), () =>
        chatComplete({ messages: MSG, sensitivity: 'published', tier: 1, escalate: false })))
    ok('chain: 前一家失敗 → 依序降級並標 fellBack',
      !error && result.provider === 'lightning-tier1' && result.fellBack === true && result.fallbackFrom === 'deepinfra' &&
        calls.map((c) => host(c.url)).join('>') === 'api.deepinfra.com>api.deepinfra.com>lightning.ai',
      error?.message || calls.map((c) => host(c.url)).join('>'))
    ok('chain: 失敗供應商的錯誤進 attempts',
      result?.attempts?.some((a) => a.provider === 'deepinfra' && /503/.test(a.error || '')), JSON.stringify(result?.attempts?.map((a) => a.provider)))
  }

  // 自訂 chain 把 lightning 排前面 → 先打 lightning
  resetCircuitBreakers()
  {
    const { calls, result } = await withEnv({ ...cfg, DUAL_RAIL_FINOPS_CHAIN: 'lightning,deepinfra' }, () =>
      withFetch(() => ({ body: completion({ content: LONG }) }), () =>
        chatComplete({ messages: MSG, tier: 1, escalate: false })))
    ok('chain: 順序由 env 決定', result?.provider === 'lightning-tier1' && host(calls[0].url) === 'lightning.ai')
  }

  // 全部未設定 → 明確錯誤，attempts 列出每家
  {
    const { calls, error } = await withEnv({ DUAL_RAIL_FINOPS_CHAIN: 'deepinfra,lightning' }, () =>
      withFetch(() => ({ body: completion() }), () => chatComplete({ messages: MSG, tier: 1 })))
    ok('chain: 全部未設定 → DUAL_RAIL_FINOPS_UNCONFIGURED、零請求',
      error?.code === 'DUAL_RAIL_FINOPS_UNCONFIGURED' && error.attempts?.length === 2 && calls.length === 0, error?.message)
  }

  // 全部失敗 → DUAL_RAIL_FINOPS_EXHAUSTED
  resetCircuitBreakers()
  {
    const { error } = await withEnv(cfg, () =>
      withFetch(() => ({ status: 500, body: 'boom' }), () => chatComplete({ messages: MSG, tier: 1, escalate: false })))
    ok('chain: 全部失敗 → DUAL_RAIL_FINOPS_EXHAUSTED',
      error?.code === 'DUAL_RAIL_FINOPS_EXHAUSTED' && error.attempts?.filter((a) => a.error).length === 2, error?.message)
  }

  // ── 政策閘門：chain 設滿、tools 帶上，internal 仍絕不出 finops ──
  {
    const { calls, result, error } = await withEnv(cfg, () =>
      withFetch(() => ({ body: completion({ content: LONG }) }), () =>
        chatComplete({ messages: MSG, internalContext: true, tier: 1, escalate: false })))
    ok('policy: chain 設滿時 internalContext 仍走 enterprise、零 finops 請求', !error && result.rail === 'enterprise' && calls.length === 0, error?.message)
  }
  {
    const { calls, error } = await withEnv(cfg, () =>
      withFetch(() => ({ body: completion() }), () =>
        chatComplete({ messages: MSG, rail: 'finops', sensitivity: 'internal', tools: TOOLS })))
    ok('policy: rail=finops＋internal＋tools 仍丟 DUAL_RAIL_INTERNAL_ON_FINOPS', error?.code === 'DUAL_RAIL_INTERNAL_ON_FINOPS' && calls.length === 0, error?.code)
  }
  {
    const { calls, error } = await withEnv(cfg, () =>
      withFetch(() => ({ body: TOOL_CALL_REPLY }), () =>
        chatComplete({ messages: MSG, internalContext: true, tools: TOOLS })))
    ok('policy: internal＋tools → DUAL_RAIL_TOOLS_UNSUPPORTED，不改走 finops', error?.code === 'DUAL_RAIL_TOOLS_UNSUPPORTED' && calls.length === 0, error?.code)
  }
  {
    const { error } = await withEnv({}, () => withFetch(() => ({}), () =>
      chatComplete({ messages: TOOL_ROUND_2, rail: 'enterprise' })))
    ok('enterprise: role:tool 訊息 → DUAL_RAIL_TOOLS_UNSUPPORTED', error?.code === 'DUAL_RAIL_TOOLS_UNSUPPORTED', error?.code)
  }
}

async function toolChecks(ok) {
  ok('finishFlags: tool_calls 不算 truncated', (() => { const f = finishFlags('tool_calls', { hasContent: true }); return !f.truncated && !f.reasoningExhausted && f.finishReason === 'tool_calls' })())

  const adapters = [
    ['together', callTogether, 'TOGETHER_API_KEY'],
    ['deepinfra', callDeepInfra, 'DEEPINFRA_API_KEY'],
    ['lightning', callLightning, 'LIGHTNING_API_KEY'],
    ['openrouter', callOpenRouter, 'OPENROUTER_API_KEY'],
  ]
  for (const [name, call, keyEnv] of adapters) {
    const { calls, result, error } = await withEnv({ [keyEnv]: 'k' }, () =>
      withFetch(() => ({ body: TOOL_CALL_REPLY }), () =>
        call({ models: ['m'], messages: TOOL_ROUND_2, maxTokens: 64, tools: TOOLS, toolChoice: 'auto' })))
    const sent = calls[0]?.body || {}
    ok(`tools/${name}: tools、tool_choice、role:tool 原樣送出`,
      JSON.stringify(sent.tools) === JSON.stringify(TOOLS) && sent.tool_choice === 'auto' &&
        sent.messages?.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1') &&
        sent.messages?.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_1'),
      error?.message || '')
    ok(`tools/${name}: toolCalls 正規化、message 原樣、不判 truncated`,
      !error && result.toolCalls?.length === 1 && result.toolCalls[0].id === 'call_1' && result.toolCalls[0].name === 'get_weather' &&
        result.toolCalls[0].arguments === '{"city":"Taipei"}' && result.message?.tool_calls?.[0]?.function?.name === 'get_weather' &&
        result.finishReason === 'tool_calls' && result.truncated === false,
      error?.message || JSON.stringify(result?.toolCalls))
  }

  // arguments 是物件的端點 → 仍正規化成字串
  {
    const reply = completion({ content: '', finish: 'tool_calls', toolCalls: [{ id: 'c2', function: { name: 'f', arguments: { a: 1 } } }] })
    const { result, error } = await withEnv({ DEEPINFRA_API_KEY: 'k' }, () =>
      withFetch(() => ({ body: reply }), () => callDeepInfra({ models: ['m'], messages: MSG, maxTokens: 8, tools: TOOLS })))
    ok('tools: 物件 arguments → JSON 字串', !error && result.toolCalls[0].arguments === '{"a":1}', error?.message)
  }

  // toolChoice 沒有 tools 時不送（避免 400）
  {
    const { calls } = await withEnv({ LIGHTNING_API_KEY: 'k' }, () =>
      withFetch(() => ({ body: completion() }), () => callLightning({ models: ['m'], messages: MSG, maxTokens: 8, toolChoice: 'auto' })))
    ok('tools: 沒有 tools 時不送 tool_choice', calls[0] && !('tool_choice' in calls[0].body) && !('tools' in calls[0].body))
  }

  // 經 chatComplete：只有 tool_calls 的空文字回覆不能被「太短」規則升階
  resetCircuitBreakers()
  {
    const { calls, result, error } = await withEnv({
      DUAL_RAIL_FINOPS_CHAIN: 'deepinfra', DEEPINFRA_API_KEY: 'k',
      DEEPINFRA_TIER1_MODELS: 't1', DEEPINFRA_TIER2_MODELS: 't2', DEEPINFRA_TIER3_MODELS: 't3',
    }, () => withFetch(() => ({ body: TOOL_CALL_REPLY }), () =>
      chatComplete({ messages: MSG, tier: 1, escalate: true, tools: TOOLS, toolChoice: { type: 'function', function: { name: 'get_weather' } } })))
    ok('tools/chatComplete: tool_calls 回覆停在 tier1、不升階',
      !error && result.tier === 1 && calls.length === 1 && result.toolCalls?.[0]?.name === 'get_weather' &&
        result.truncated === false && result.message?.tool_calls?.length === 1 && calls[0].body.tool_choice?.function?.name === 'get_weather',
      error?.message || `tier=${result?.tier} calls=${calls.length}`)
  }
  // 沒有工具時，結果仍帶 toolCalls:[] 與 message（呼叫端不必判斷 undefined）
  {
    const { result } = await withEnv({}, () => withFetch(() => ({}), () => chatComplete({ messages: MSG, internalContext: true })))
    ok('result: 無工具時 toolCalls=[]、message 存在', Array.isArray(result?.toolCalls) && result.toolCalls.length === 0 && result.message?.role === 'assistant')
  }
}

export async function runChainToolChecks(ok) {
  await chainChecks(ok)
  await toolChecks(ok)
}
