// Enterprise rail adapter — Vertex AI Gemini (boundary-bound path).
//
// Production: VERTEX_PROJECT_ID + Application Default Credentials / VERTEX_ACCESS_TOKEN
// Verification: ENTERPRISE_ADAPTER=mock (no network; proves policy + tier path)

import { envList, envInt, finishFlags } from '../env.mjs'

const REQUEST_TIMEOUT_MS = envInt('VERTEX_TIMEOUT_MS', 45_000)
const LOCATION = process.env.VERTEX_LOCATION || 'us-central1'

export const ENTERPRISE_TIERS = {
  1: {
    name: 'light',
    models: envList(
      'VERTEX_TIER1_MODELS',
      'gemini-2.0-flash-001,gemini-2.0-flash-lite-001',
    ),
  },
  2: {
    name: 'standard',
    models: envList(
      'VERTEX_TIER2_MODELS',
      'gemini-2.5-flash,gemini-2.0-flash-001',
    ),
  },
  3: {
    name: 'flagship',
    models: envList(
      'VERTEX_TIER3_MODELS',
      process.env.VERTEX_PAID_MODEL
        ? `${process.env.VERTEX_PAID_MODEL},gemini-2.5-pro`
        : 'gemini-2.5-pro,gemini-2.5-flash',
    ),
  },
}

export function listEnterpriseModels(tier) {
  return ENTERPRISE_TIERS[tier]?.models?.slice() || []
}

export function enterpriseTierName(tier) {
  return ENTERPRISE_TIERS[tier]?.name || `tier-${tier}`
}

export function isEnterpriseMock() {
  return (process.env.ENTERPRISE_ADAPTER || '').toLowerCase() === 'mock'
}

export function isEnterpriseConfigured() {
  // Must mirror resolveAccessToken(): only VERTEX_ACCESS_TOKEN (or mock) actually
  // works. Accepting GOOGLE_APPLICATION_CREDENTIALS here used to report
  // "configured" for an ADC setup that then failed at call time.
  if (isEnterpriseMock()) return true
  return Boolean(process.env.VERTEX_PROJECT_ID && process.env.VERTEX_ACCESS_TOKEN)
}

/**
 * 工具呼叫在 enterprise 軌不支援（0.3.0）。
 *
 * Vertex generateContent 的工具形狀（functionDeclarations／functionCall／functionResponse）
 * 與 OpenAI function 格式不同，本 adapter 又把每則訊息攤平成純文字——
 * 若默默忽略 tools，呼叫端會拿到「模型沒呼叫工具」的正常回覆，錯得看不出來；
 * 若把 role:'tool' 訊息當 user 文字送出，工具結果會被當成使用者發言。
 * 兩種都比明確丟錯糟，所以直接丟 DUAL_RAIL_TOOLS_UNSUPPORTED。
 *
 * 注意：丟錯**不會**讓呼叫改走 finops —— internal 資料的閘門優先於功能需求。
 */
export function assertNoToolsForEnterprise({ tools, toolChoice, messages } = {}) {
  const hasTools = Array.isArray(tools) ? tools.length > 0 : tools != null
  const hasToolMessages = (messages || []).some((m) => m?.role === 'tool' || (Array.isArray(m?.tool_calls) && m.tool_calls.length))
  if (hasTools || toolChoice != null || hasToolMessages) {
    const err = new Error(
      'Enterprise rail (Vertex) does not support tool calling in pvl-dual-rail yet — ' +
        'remove tools/toolChoice/tool messages, or handle the tool loop outside the enterprise rail',
    )
    err.code = 'DUAL_RAIL_TOOLS_UNSUPPORTED'
    throw err
  }
}

function systemToText(system) {
  if (system == null) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n\n')
  }
  return String(system)
}

function toGeminiContents(system, messages) {
  const contents = []
  const sys = systemToText(system)
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user'
    contents.push({ role, parts: [{ text: String(m.content || '') }] })
  }
  return { systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, contents }
}

async function resolveAccessToken() {
  if (process.env.VERTEX_ACCESS_TOKEN) return process.env.VERTEX_ACCESS_TOKEN
  // ADC via gcloud metadata is out of scope for this minimal adapter;
  // callers should set VERTEX_ACCESS_TOKEN or use mock for verification.
  throw new Error('Enterprise rail: set VERTEX_ACCESS_TOKEN (or ENTERPRISE_ADAPTER=mock)')
}

/**
 * Call Vertex generateContent for the first reachable model in `models`.
 */
export async function callEnterprise({
  models,
  system,
  messages,
  maxTokens,
  json = false,
  tools,
  toolChoice,
}) {
  assertNoToolsForEnterprise({ tools, toolChoice, messages })
  if (isEnterpriseMock()) {
    const model = models[0] || 'mock-gemini'
    const preview = String(messages?.[0]?.content || '').slice(0, 80)
    return {
      text: `[enterprise-mock · ${model}] OK — boundary path engaged. Preview: ${preview || '(empty)'}`.padEnd(48, '.'),
      model,
      usage: null,
      ...finishFlags('STOP', { hasContent: true }),  // mock：永遠完整
      providerSlug: 'mock-vertex',
    }
  }

  const project = process.env.VERTEX_PROJECT_ID
  if (!project) throw new Error('Enterprise rail: VERTEX_PROJECT_ID missing')

  const token = await resolveAccessToken()
  const { systemInstruction, contents } = toGeminiContents(system, messages)

  let lastErr
  for (const model of models) {
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`
    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }
    if (systemInstruction) body.systemInstruction = systemInstruction

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        const err = new Error(`Vertex ${model} HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
        err.status = resp.status
        lastErr = err
        continue
      }
      const data = await resp.json()
      const text = (data.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim()
      return {
        text,
        model,
        usage: data.usageMetadata || null,
        cachedTokens: Number.isFinite(data.usageMetadata?.cachedContentTokenCount) ? data.usageMetadata.cachedContentTokenCount : null,
        ...finishFlags(data.candidates?.[0]?.finishReason, { hasContent: true, hasReasoning: false }),
        providerSlug: 'vertex-ai',
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('Enterprise rail: all Vertex models failed')
}
