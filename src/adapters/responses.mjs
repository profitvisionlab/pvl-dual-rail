// OpenAI Responses API 的格式轉換（0.4.0，2026-09-17）。
//
// 為什麼需要：OpenAI 推理世代（gpt-5.5、gpt-5.6 luna／terra／sol、gpt-6-astra）
// 在 /chat/completions **不接受「推理＋function tools」**，OpenAI 直連與 Lightning 都回
// 「Function tools with reasoning_effort are not supported … use /v1/responses」。
// 要讓它們帶工具，只能走 /v1/responses。
//
// 設計原則：**呼叫端完全不用改。** chatComplete 的輸入仍是 chat 形狀的 messages／tools，
// 輸出仍是 { text, toolCalls, message, usage, finishReason… }。轉換只發生在 adapter 內。
//
// 回填工具結果時**不需要**帶回推理項目（reasoning item）：2026-09-17 以真金鑰實測
// gpt-5.6-luna（OpenAI 直連與 Lightning）與 gpt-6-astra（OpenAI 直連），只送
// function_call（不帶 id）＋ function_call_output、store:false，三組都完成來回。
// 所以 message 維持標準 chat 形狀，換供應商時也能原樣回填。
//
// store 一律 false：資料不留在 OpenAI 端，也就不依賴 previous_response_id。

/** chat 形狀的 content（字串或 parts 陣列）→ Responses 的 input content。 */
function toInputContent(content) {
  if (typeof content === 'string' || content == null) return content ?? ''
  if (!Array.isArray(content)) return String(content)
  return content.map((part) => {
    if (typeof part === 'string') return { type: 'input_text', text: part }
    if (part?.type === 'text') return { type: 'input_text', text: part.text ?? '' }
    if (part?.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url ?? part.image_url }
    return part
  })
}

const textOfContent = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
      : ''

/**
 * chat messages → { instructions（system 訊息合併）, input（Responses items）}。
 * assistant 的 tool_calls 轉成 function_call item；role:'tool' 轉成 function_call_output。
 */
export function toResponsesInput(messages = []) {
  const systemParts = []
  const input = []
  for (const m of messages) {
    if (!m) continue
    if (m.role === 'system' || m.role === 'developer') {
      const t = textOfContent(m.content)
      if (t) systemParts.push(t)
      continue
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      })
      continue
    }
    if (m.role === 'assistant') {
      const text = textOfContent(m.content)
      if (text) input.push({ role: 'assistant', content: text })
      for (const tc of m.tool_calls || []) {
        const args = tc?.function?.arguments
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc?.function?.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        })
      }
      continue
    }
    input.push({ role: m.role || 'user', content: toInputContent(m.content) })
  }
  return { systemParts, input }
}

/** chat 的 {type:'function', function:{…}} → Responses 的扁平 {type:'function', name, …}；已是扁平形狀就原樣。 */
export function toResponsesTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null
  return tools.map((t) =>
    t?.type === 'function' && t.function
      ? { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, ...(t.function.strict != null ? { strict: t.function.strict } : {}) }
      : t,
  )
}

export function toResponsesToolChoice(toolChoice) {
  if (toolChoice == null || typeof toolChoice === 'string') return toolChoice
  if (toolChoice?.type === 'function' && toolChoice.function?.name) return { type: 'function', name: toolChoice.function.name }
  return toolChoice
}

/** 組 /responses 的 request body。system 可以是字串（flattenSystem 之後）。 */
export function buildResponsesBody({ model, system, messages, maxTokens, json, tools, toolChoice }) {
  const { systemParts, input } = toResponsesInput(messages)
  const instructions = [system, ...systemParts].filter((s) => typeof s === 'string' && s.length).join('\n\n')
  const rTools = toResponsesTools(tools)
  const body = { model, input, store: false }
  if (json) {
    // OpenAI 規定：json_object 模式下「input 訊息」要出現 json 字樣，寫在 instructions 不算
    // （2026-09-17 實測 400：Response input messages must contain the word 'json'）。
    // chat 路徑是 system 訊息就算數，為了語意一致，JSON 模式把系統提示改成 developer 訊息放進 input。
    if (instructions) input.unshift({ role: 'developer', content: instructions })
    const mentionsJson = input.some((i) => /json/i.test(typeof i.content === 'string' ? i.content : JSON.stringify(i.content ?? '')))
    if (!mentionsJson) input.unshift({ role: 'developer', content: 'Respond with valid JSON.' })
    body.text = { format: { type: 'json_object' } }
  } else if (instructions) {
    body.instructions = instructions
  }
  if (maxTokens != null) body.max_output_tokens = maxTokens
  if (rTools) {
    body.tools = rTools
    if (toolChoice != null) body.tool_choice = toResponsesToolChoice(toolChoice)
  }
  return body
}

/**
 * /responses 的回應 → 與 chat 路徑相同的欄位。
 * usage 轉成 chat 形狀（prompt_tokens／completion_tokens／prompt_tokens_details.cached_tokens），
 * 原始 usage 放在 usage.responses，成本分析仍拿得到 reasoning_tokens。
 */
export function parseResponsesResult(j) {
  const output = Array.isArray(j?.output) ? j.output : []
  const text =
    typeof j?.output_text === 'string'
      ? j.output_text
      : output
          .filter((o) => o?.type === 'message')
          .flatMap((o) => o.content || [])
          .filter((c) => c?.type === 'output_text')
          .map((c) => c.text ?? '')
          .join('')
  const toolCalls = output
    .filter((o) => o?.type === 'function_call')
    .map((c) => ({ id: c.call_id ?? c.id ?? null, name: c.name ?? null, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? '') }))
  const message = {
    role: 'assistant',
    content: text.length ? text : null,
    ...(toolCalls.length ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}),
  }
  const reasoningItems = output.filter((o) => o?.type === 'reasoning')
  const reasoningText = reasoningItems.flatMap((r) => r.summary || []).map((s) => s?.text ?? '').filter(Boolean).join('\n')
  const u = j?.usage
  const reasoningTokens = u?.output_tokens_details?.reasoning_tokens ?? 0
  const usage = u
    ? {
        prompt_tokens: u.input_tokens ?? null,
        completion_tokens: u.output_tokens ?? null,
        total_tokens: u.total_tokens ?? null,
        prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? null },
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
        responses: u,
      }
    : null
  let finishReason = 'stop'
  if (toolCalls.length) finishReason = 'tool_calls'
  else if (j?.status === 'incomplete') finishReason = j?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : (j?.incomplete_details?.reason ?? 'incomplete')
  return {
    text,
    toolCalls,
    message,
    usage,
    finishReason,
    hasReasoning: reasoningItems.length > 0 || reasoningTokens > 0,
    reasoning: reasoningText || null,
    model: j?.model ?? null,
  }
}

/** base URL（或已指到 /chat/completions 的完整 URL）→ /responses URL。 */
export function responsesUrl(base) {
  const trimmed = String(base).replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  return /\/responses$/.test(trimmed) ? trimmed : `${trimmed}/responses`
}
