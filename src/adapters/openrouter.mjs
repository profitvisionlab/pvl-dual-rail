// FinOps rail adapter — OpenRouter Tri-Tier (cost path).
// Must never receive internalContext payloads (enforced by policy before call).

import { envList, envInt } from '../env.mjs'

const PROVIDER_ORDER_REALTIME = envList(
  'OPENROUTER_PROVIDER_ORDER',
  '',
)
const PROVIDER_ORDER_BATCH = envList(
  'OPENROUTER_PROVIDER_ORDER_BATCH',
  '',
)
// Optional only — default bf16/fp16 filters out Claude/GPT (404).
const PROVIDER_QUANTIZATIONS = process.env.OPENROUTER_QUANTIZATIONS
  ? envList('OPENROUTER_QUANTIZATIONS')
  : null
const DATA_COLLECTION = process.env.OPENROUTER_DATA_COLLECTION || 'deny'
const MAX_RETRIES = envInt('OPENROUTER_MAX_RETRIES', 3)
const BACKOFF_BASE_MS = envInt('OPENROUTER_BACKOFF_BASE_MS', 100)
const REQUEST_TIMEOUT_MS = envInt('OPENROUTER_TIMEOUT_MS', 45_000)

export const FINOPS_TIERS = {
  1: {
    name: 'light',
    models: envList(
      'OPENROUTER_TIER1_MODELS',
      [
        ...envList(
          'OPENROUTER_FREE_MODELS',
          '',
        ),
        'google/gemini-2.5-flash',
        '',
      ].join(','),
    ),
  },
  2: {
    name: 'standard',
    models: envList(
      'OPENROUTER_TIER2_MODELS',
      'anthropic/claude-3.5-haiku,openai/gpt-4o-mini',
    ),
  },
  3: {
    name: 'flagship',
    models: envList(
      'OPENROUTER_TIER3_MODELS',
      process.env.OPENROUTER_PAID_MODEL
        ? `${process.env.OPENROUTER_PAID_MODEL},openai/gpt-4o`
        : 'anthropic/claude-sonnet-4.5,openai/gpt-4o',
    ),
  },
}

export function listFinopsModels(tier) {
  return FINOPS_TIERS[tier]?.models?.slice() || []
}

export function finopsTierName(tier) {
  return FINOPS_TIERS[tier]?.name || `tier-${tier}`
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function providerPrefs(mode) {
  const prefs = {
    sort: mode === 'batch' ? 'price' : 'latency',
    order: mode === 'batch' ? PROVIDER_ORDER_BATCH : PROVIDER_ORDER_REALTIME,
    data_collection: DATA_COLLECTION,
  }
  if (PROVIDER_QUANTIZATIONS?.length) prefs.quantizations = PROVIDER_QUANTIZATIONS
  return prefs
}

function isRetryableStatus(status) {
  return status === 429 || status === 408 || status >= 500
}

function normalizeSystem(system) {
  if (system == null) return null
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system
  return String(system)
}

export function isFinopsConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY)
}

/**
 * One OpenRouter completion with native multi-model fallback + provider triage.
 */
export async function callOpenRouter({
  models,
  system,
  messages,
  maxTokens,
  json = false,
  mode = 'realtime',
}) {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('FinOps rail: OPENROUTER_API_KEY missing')

  const sys = normalizeSystem(system)
  const msgPayload = []
  if (sys != null) msgPayload.push({ role: 'system', content: sys })
  msgPayload.push(...messages)

  const body = {
    models,
    route: 'fallback',
    max_tokens: maxTokens,
    messages: msgPayload,
    provider: providerPrefs(mode),
  }
  if (models.length === 1) body.model = models[0]
  if (json) body.response_format = { type: 'json_object' }

  let lastErr
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(2 ** (attempt - 1) * BACKOFF_BASE_MS)
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://github.com/profitvisionlab/pvl-dual-rail',
          'X-Title': 'PVL.AI Dual-Rail',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        const err = new Error(
          `OpenRouter [${models[0]}${models.length > 1 ? `+${models.length - 1}` : ''}] HTTP ${resp.status}: ${errBody.slice(0, 300)}`,
        )
        err.status = resp.status
        if (isRetryableStatus(resp.status) && attempt < MAX_RETRIES) {
          lastErr = err
          continue
        }
        throw err
      }
      const data = await resp.json()
      return {
        text: data.choices?.[0]?.message?.content?.trim() || '',
        model: data.model || models[0],
        usage: data.usage || null,
        providerSlug: data.provider || null,
      }
    } catch (e) {
      lastErr = e
      const status = e.status
      const abort = e.name === 'TimeoutError' || e.name === 'AbortError'
      if ((abort || isRetryableStatus(status) || !status) && attempt < MAX_RETRIES) continue
      throw e
    }
  }
  throw lastErr || new Error('OpenRouter request failed')
}
