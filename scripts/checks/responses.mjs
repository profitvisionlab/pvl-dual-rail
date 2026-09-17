// Responses API（0.4.0）離線檢查：格式轉換、OpenAI 直連、Lightning 路由、完整工具來回。
// 行為依據是 2026-09-17 真金鑰實測（見 README「真金鑰實測」）。

import { withEnv, withFetch, completion } from './mock.mjs'
import { buildResponsesBody, parseResponsesResult, responsesUrl } from '../../src/adapters/responses.mjs'
import { callOpenAI } from '../../src/adapters/openai.mjs'
import { callLightning } from '../../src/adapters/lightning.mjs'
import { chatComplete, resetCircuitBreakers, resolveFinopsChain } from '../../src/index.mjs'

const TOOLS = [{ type: 'function', function: { name: 'get_store_hours', description: 'Hours', parameters: { type: 'object', properties: { branch: { type: 'string' } } } } }]
const MSG = [{ role: 'user', content: '暖麥烘焙信義店幾點開門？' }]

/** Responses 形狀的回覆。 */
function response({ text, calls, status = 'completed', reason, reasoning = false, cached = 0, reasoningTokens = 0 } = {}) {
  const output = []
  if (reasoning) output.push({ type: 'reasoning', id: 'rs_1', summary: [] })
  for (const c of calls || []) output.push({ type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: c.arguments, status: 'completed' })
  if (text != null) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  return {
    id: 'resp_1', object: 'response', model: 'gpt-5.6-luna', status,
    ...(reason ? { incomplete_details: { reason } } : {}),
    output,
    usage: { input_tokens: 120, input_tokens_details: { cached_tokens: cached }, output_tokens: 40, output_tokens_details: { reasoning_tokens: reasoningTokens }, total_tokens: 160 },
  }
}
const CALL = { id: 'call_abc', name: 'get_store_hours', arguments: '{"branch":"信義店"}' }

function unitChecks(ok) {
  const body = buildResponsesBody({
    model: 'gpt-5.6-luna',
    system: '系統提示',
    messages: [
      { role: 'system', content: '第二段系統' },
      ...MSG,
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_store_hours', arguments: '{"branch":"信義店"}' } }] },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"open":"07:30"}' },
    ],
    maxTokens: 900, json: true, tools: TOOLS, toolChoice: { type: 'function', function: { name: 'get_store_hours' } },
  })
  const plain = buildResponsesBody({ model: 'm', system: '系統提示', messages: [{ role: 'system', content: '第二段系統' }, ...MSG] })
  ok('responses body: 非 JSON 模式 → system 與 system 訊息合併成 instructions', plain.instructions === '系統提示\n\n第二段系統', plain.instructions)
  ok('responses body: JSON 模式 → 系統提示改成 developer 訊息放進 input（OpenAI 只認 input 裡的 json 字樣）',
    !('instructions' in body) && body.input.some((i) => i.role === 'developer' && i.content === '系統提示\n\n第二段系統'), JSON.stringify(body.input.slice(0, 2)))
  const noJsonWord = buildResponsesBody({ model: 'm', system: '只輸出結果', messages: MSG, json: true })
  ok('responses body: JSON 模式且全文沒有 json 字樣 → 補一句 developer 要求', noJsonWord.input.some((i) => i.role === 'developer' && /json/i.test(i.content)))
  const hasJsonWord = buildResponsesBody({ model: 'm', messages: [{ role: 'user', content: 'return json please' }], json: true })
  ok('responses body: JSON 模式且 input 已有 json 字樣 → 不多補', !hasJsonWord.input.some((i) => i.role === 'developer'))
  ok('responses body: store:false、max_output_tokens、沒有 messages 欄位', body.store === false && body.max_output_tokens === 900 && !('messages' in body))
  ok('responses body: json → text.format json_object', body.text?.format?.type === 'json_object')
  ok('responses body: tools 攤平成 {type,name,parameters}', body.tools?.[0]?.name === 'get_store_hours' && !body.tools[0].function)
  ok('responses body: tool_choice function 形狀轉換', body.tool_choice?.type === 'function' && body.tool_choice.name === 'get_store_hours')
  const types = body.input.map((i) => i.type ?? i.role).join(',')
  ok('responses body: assistant tool_calls → function_call、tool → function_call_output', types === 'developer,developer,user,function_call,function_call_output', types)
  const fc = body.input.find((i) => i.type === 'function_call')
  ok('responses body: function_call 帶 call_id、不帶 id（實測回填不需要推理項目）', fc.call_id === 'call_abc' && !('id' in fc) && fc.arguments === '{"branch":"信義店"}', JSON.stringify(fc))
  ok('responses body: 沒給 tools 就不帶 tools／tool_choice', !('tools' in buildResponsesBody({ model: 'm', messages: MSG, toolChoice: 'auto' })))

  const p1 = parseResponsesResult(response({ calls: [CALL], reasoning: true, reasoningTokens: 9, cached: 64 }))
  ok('responses parse: function_call → toolCalls＋message.tool_calls', p1.toolCalls[0]?.id === 'call_abc' && p1.message.tool_calls?.[0]?.function?.name === 'get_store_hours' && p1.message.content === null)
  ok('responses parse: 有工具呼叫 → finishReason tool_calls', p1.finishReason === 'tool_calls')
  ok('responses parse: usage 轉 chat 形狀並保留原始 usage', p1.usage.prompt_tokens === 120 && p1.usage.prompt_tokens_details.cached_tokens === 64 && p1.usage.responses?.output_tokens_details?.reasoning_tokens === 9)
  const p2 = parseResponsesResult(response({ text: '七點半開門。' }))
  ok('responses parse: 沒有 output_text 時從 message item 組出文字', p2.text === '七點半開門。' && p2.finishReason === 'stop')
  const p3 = parseResponsesResult(response({ status: 'incomplete', reason: 'max_output_tokens', reasoning: true, reasoningTokens: 900 }))
  ok('responses parse: incomplete／max_output_tokens → length＋hasReasoning', p3.finishReason === 'length' && p3.hasReasoning && p3.text === '')

  ok('responsesUrl: base 與 chat/completions URL 都換成 /responses',
    responsesUrl('https://api.openai.com/v1/') === 'https://api.openai.com/v1/responses' &&
    responsesUrl('https://lightning.ai/api/v1/chat/completions') === 'https://lightning.ai/api/v1/responses')
}

async function openaiChecks(ok) {
  const env = { OPENAI_API_KEY: 'sk-test_123' }
  {
    const { calls, result, error } = await withEnv(env, () =>
      withFetch(() => ({ body: response({ calls: [CALL], reasoning: true, cached: 64 }) }), () =>
        callOpenAI({ models: ['gpt-5.6-luna'], system: 's', messages: MSG, maxTokens: 800, tools: TOOLS, toolChoice: 'auto' })))
    ok('openai: 走 https://api.openai.com/v1/responses', calls[0]?.url === 'https://api.openai.com/v1/responses', calls[0]?.url ?? error?.message)
    ok('openai: result.api＝responses、toolCalls 正規化、cachedTokens 讀得到', result?.api === 'responses' && result.toolCalls[0]?.id === 'call_abc' && result.cachedTokens === 64, JSON.stringify(result?.toolCalls))
    ok('openai: tool_calls 回覆不算 truncated', result?.finishReason === 'tool_calls' && result.truncated === false)
  }
  {
    // 回填第二輪：直接 push result.message（chat 形狀）＋ tool 訊息
    const { calls, result } = await withEnv(env, () =>
      withFetch(() => ({ body: response({ text: '暖麥烘焙信義店早上 7:30 開門。' }) }), async () => {
        const first = parseResponsesResult(response({ calls: [CALL] }))
        return callOpenAI({ models: ['gpt-6-astra'], messages: [...MSG, first.message, { role: 'tool', tool_call_id: 'call_abc', content: '{"open":"07:30"}' }], maxTokens: 800, tools: TOOLS })
      }))
    const input = calls[0]?.body?.input || []
    ok('openai 來回: 第二輪 input 帶 function_call 與同 call_id 的 function_call_output',
      input.some((i) => i.type === 'function_call' && i.call_id === 'call_abc') && input.some((i) => i.type === 'function_call_output' && i.call_id === 'call_abc'), JSON.stringify(input))
    ok('openai 來回: 最終文字正確', result?.text === '暖麥烘焙信義店早上 7:30 開門。')
  }
  {
    const { error } = await withEnv(env, () =>
      withFetch(() => ({ body: response({ status: 'incomplete', reason: 'max_output_tokens', reasoning: true, reasoningTokens: 50 }) }), () =>
        callOpenAI({ models: ['gpt-5.6-sol'], messages: MSG, maxTokens: 50 })))
    ok('openai: 推理吃光 max_output_tokens → DUAL_RAIL_REASONING_EXHAUSTED', error?.code === 'DUAL_RAIL_REASONING_EXHAUSTED', error?.message)
  }
  {
    const { result } = await withEnv(env, () =>
      withFetch(() => ({ body: response({ text: '寫到一半', status: 'incomplete', reason: 'max_output_tokens' }) }), () =>
        callOpenAI({ models: ['gpt-5.6-luna'], messages: MSG, maxTokens: 10 })))
    ok('openai: 有文字但 incomplete → truncated', result?.truncated === true && result.text === '寫到一半')
  }
  {
    const { calls } = await withEnv(env, () =>
      withFetch(() => ({ body: response({ text: '{"ok":true}' }) }), () => callOpenAI({ models: ['gpt-5.6-luna'], messages: MSG, maxTokens: 50, json: true })))
    ok('openai: json:true → text.format json_object', calls[0]?.body?.text?.format?.type === 'json_object')
  }
}

async function lightningRoutingChecks(ok) {
  const env = { LIGHTNING_API_KEY: 'sk-test_123' }
  const path = (url) => new URL(url).pathname
  const handler = (c) => ({ body: path(c.url).endsWith('/responses') ? response({ calls: [CALL] }) : completion({ content: 'ok ok ok' }) })
  const { calls } = await withEnv(env, () =>
    withFetch(handler, async () => {
      await callLightning({ models: ['openai/gpt-5.6-luna'], messages: MSG, maxTokens: 64, tools: TOOLS })
      await callLightning({ models: ['openai/gpt-5.6-luna'], messages: MSG, maxTokens: 64 })
      await callLightning({ models: ['google/gemini-2.5-flash'], messages: MSG, maxTokens: 64, tools: TOOLS })
    }))
  ok('lightning: OpenAI 推理模型＋tools → /api/v1/responses', path(calls[0]?.url ?? 'http://x/') === '/api/v1/responses', calls[0]?.url)
  ok('lightning: 同模型不帶 tools → 維持 chat（max_completion_tokens）', path(calls[1]?.url ?? 'http://x/') === '/api/v1/chat/completions' && calls[1]?.body?.max_completion_tokens === 64)
  ok('lightning: 非 OpenAI 模型帶 tools → 維持 chat', path(calls[2]?.url ?? 'http://x/') === '/api/v1/chat/completions')
  {
    const { calls: c2 } = await withEnv({ ...env, LIGHTNING_RESPONSES: 'never' }, () =>
      withFetch(handler, () => callLightning({ models: ['openai/gpt-5.6-luna'], messages: MSG, maxTokens: 64, tools: TOOLS })))
    ok('lightning: LIGHTNING_RESPONSES=never → 帶 tools 也走 chat', path(c2[0]?.url ?? 'http://x/') === '/api/v1/chat/completions')
  }
  {
    // 實測：gpt-6-astra 在 Lightning /responses 回 400「model does not support the Responses API」
    const { calls: c3, result, error } = await withEnv({ ...env, LIGHTNING_MAX_ATTEMPTS: '3' }, () =>
      withFetch((c) => (c.body.model === 'openai/gpt-6-astra'
        ? { status: 400, body: 'model does not support the Responses API: openai/gpt-6-astra' }
        : { body: response({ calls: [CALL] }) }), () =>
        callLightning({ models: ['openai/gpt-6-astra', 'openai/gpt-5.6-sol'], messages: MSG, maxTokens: 64, tools: TOOLS })))
    const g6 = c3.filter((c) => c.body.model === 'openai/gpt-6-astra').length
    ok('lightning: gpt-6 不支援 Responses → 只打 1 次、換到 gpt-5.6-sol', g6 === 1 && result?.toolCalls?.[0]?.id === 'call_abc', `gpt6=${g6} err=${error?.message}`)
  }
  {
    const { error } = await withEnv(env, () =>
      withFetch(() => ({ status: 400, body: 'model does not support the Responses API: openai/gpt-6-astra' }), () =>
        callLightning({ models: ['openai/gpt-6-astra'], messages: MSG, maxTokens: 64, tools: TOOLS })))
    ok('lightning: 唯一模型不支援 Responses → DUAL_RAIL_TOOLS_UNSUPPORTED', error?.code === 'DUAL_RAIL_TOOLS_UNSUPPORTED', error?.message)
  }
}

async function chainChecks(ok) {
  ok('chain: openai 是合法名稱', resolveFinopsChain('deepinfra,openai').join(',') === 'deepinfra,openai')
  {
    const out = await withEnv({ OPENAI_API_KEY: 'sk-test_123', TOGETHER_API_KEY: 'tg', TOGETHER_TIER1_MODELS: 'm' }, async () => {
      resetCircuitBreakers()
      const chain = resolveFinopsChain()
      const r = await withFetch((c) => ({ body: completion({ content: 'This reply is intentionally longer than forty characters to pass.' }) }), () =>
        chatComplete({ messages: MSG, sensitivity: 'public', tier: 1, escalate: false }))
      return { chain, hosts: r.calls.map((c) => new URL(c.url).hostname) }
    })
    ok('chain: 設了 OPENAI_API_KEY 預設 chain 仍是 together,openrouter、不打 OpenAI',
      out.chain.join(',') === 'together,openrouter' && !out.hosts.includes('api.openai.com'), JSON.stringify(out))
  }
  {
    const { calls, result, error } = await withEnv({ DUAL_RAIL_FINOPS_CHAIN: 'openai', OPENAI_API_KEY: 'sk-test_123', OPENAI_TIER1_MODELS: 'gpt-5.6-luna' }, async () => {
      resetCircuitBreakers()
      return withFetch(() => ({ body: response({ calls: [CALL], reasoning: true }) }), () =>
        chatComplete({ messages: MSG, tools: TOOLS, toolChoice: 'auto', sensitivity: 'public', tier: 1, escalate: false }))
    })
    ok('chatComplete: 回傳 api＝responses（經 router 不遺失）', result?.api === 'responses', `api=${result?.api}`)
    ok('chatComplete: chain=openai 帶工具 → provider openai、toolCalls 正確',
      String(result?.provider).startsWith('openai') && result.toolCalls?.[0]?.name === 'get_store_hours' && calls.length === 1, error?.message ?? `provider=${result?.provider} calls=${calls.length}`)
  }
  {
    const { calls, error } = await withEnv({ DUAL_RAIL_FINOPS_CHAIN: 'openai', OPENAI_API_KEY: 'sk-test_123', OPENAI_TIER1_MODELS: 'gpt-5.6-luna' }, async () => {
      resetCircuitBreakers()
      return withFetch(() => ({ body: response({ text: 'x' }) }), () =>
        chatComplete({ messages: MSG, sensitivity: 'internal', rail: 'finops', tier: 1 }))
    })
    ok('policy: internal 資料不會因為有 openai 通道就上 finops', error?.code === 'DUAL_RAIL_INTERNAL_ON_FINOPS' && calls.length === 0, error?.code)
  }
}

export async function runResponsesChecks(ok) {
  unitChecks(ok)
  await openaiChecks(ok)
  await lightningRoutingChecks(ok)
  await chainChecks(ok)
}
