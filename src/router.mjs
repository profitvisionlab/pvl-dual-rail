// Shared Tri-Tier brain: resolveTier, escalate, circuit breaker.
// Adapters only know how to call a provider for a given model list.

import { envInt } from './env.mjs'

export const TASK_TIER = {
  classify: 1,
  extract: 1,
  json: 1,
  clean: 1,
  intent: 1,
  summarize: 2,
  generate: 2,
  compare: 2,
  draft: 2,
  code: 3,
  analysis: 3,
  strategy: 3,
  reason: 3,
}

export const HEAVY_CONTEXT_TOKENS = envInt('OPENROUTER_HEAVY_CONTEXT_TOKENS', 6000)
export const MID_CONTEXT_TOKENS = envInt('OPENROUTER_MID_CONTEXT_TOKENS', 2500)
export const MIN_VALID_REPLY_CHARS = envInt('OPENROUTER_MIN_REPLY_CHARS', 40)

const CB_FAILURE_THRESHOLD = envInt('OPENROUTER_CB_FAILURES', 5)
const CB_WINDOW_MS = envInt('OPENROUTER_CB_WINDOW_MS', 60_000)
const CB_COOLDOWN_MS = envInt('OPENROUTER_CB_COOLDOWN_MS', 300_000)

const breakers = new Map()

function getBreaker(key) {
  if (!breakers.has(key)) breakers.set(key, { failures: [], openUntil: 0 })
  return breakers.get(key)
}

export function breakerAllow(key) {
  return Date.now() >= getBreaker(key).openUntil
}

export function breakerRecordSuccess(key) {
  const b = getBreaker(key)
  b.failures = []
  b.openUntil = 0
}

export function breakerRecordFailure(key) {
  const b = getBreaker(key)
  const now = Date.now()
  b.failures = b.failures.filter((t) => now - t < CB_WINDOW_MS)
  b.failures.push(now)
  if (b.failures.length >= CB_FAILURE_THRESHOLD) {
    b.openUntil = now + CB_COOLDOWN_MS
    b.failures = []
  }
}

export function getCircuitBreakerStatus() {
  const now = Date.now()
  const out = {}
  for (const [key, b] of breakers) {
    out[key] = {
      open: now < b.openUntil,
      openUntil: b.openUntil || null,
      recentFailures: b.failures.filter((t) => now - t < CB_WINDOW_MS).length,
    }
  }
  return out
}

/** Reset breakers — for tests only. */
export function resetCircuitBreakers() {
  breakers.clear()
}

/**
 * Resolve which tier to start on.
 * Priority: explicit `tier` > `task` map > contextTokens heuristic > default 1.
 */
export function resolveTier({ tier, task, contextTokens } = {}) {
  if (tier === 1 || tier === 2 || tier === 3) return tier
  if (task && TASK_TIER[task]) return TASK_TIER[task]
  if (typeof contextTokens === 'number') {
    if (contextTokens > HEAVY_CONTEXT_TOKENS) return 3
    if (contextTokens > MID_CONTEXT_TOKENS) return 2
  }
  return 1
}

/**
 * Run Tri-Tier schedule against an adapter.
 *
 * @param {object} opts
 * @param {(tier: number) => string[]} opts.listModels
 * @param {(args: object) => Promise<{text:string, model:string, usage?:any, providerSlug?:string}>} opts.callTier
 * @param {object} opts.callArgs - forwarded to callTier (system, messages, …)
 * @param {string} [opts.breakerPrefix='tier'] - circuit key prefix (e.g. finops / enterprise)
 */
export async function runTier({
  listModels,
  callTier,
  callArgs,
  tierNameOf,
  startTier,
  escalate = true,
  contextTokens,
  breakerPrefix = 'tier',
  providerLabel = 'provider',
} = {}) {
  const maxTier = escalate ? 3 : startTier
  const attempts = []

  for (let tier = startTier; tier <= maxTier; tier++) {
    const key = `${breakerPrefix}-${tier}`
    if (!breakerAllow(key)) {
      attempts.push({ tier, skipped: 'circuit-open' })
      continue
    }

    const models = listModels(tier)
    if (!models.length) {
      attempts.push({ tier, skipped: 'no-models' })
      continue
    }

    try {
      const result = await callTier({ ...callArgs, models, tier })

      if (result.text.length < MIN_VALID_REPLY_CHARS && tier < maxTier) {
        attempts.push({ tier, model: result.model, skipped: 'short-reply' })
        continue
      }
      // C1：結構化輸出被 max_tokens 切斷＝整包報廢，不能當成功回傳；還有更高階就升，沒有就丟錯。
      if (result.truncated && callArgs?.json) {
        attempts.push({ tier, model: result.model, skipped: 'truncated-json' })
        if (tier < maxTier) continue
        const err = new Error(`JSON output truncated at max_tokens on ${result.model}（finish_reason=${result.finishReason}）——調高 maxTokens 或縮小輸入`)
        err.code = 'DUAL_RAIL_TRUNCATED_JSON'
        err.attempts = attempts
        throw err
      }

      breakerRecordSuccess(key)
      const escalated = tier > startTier
      return {
        text: result.text,
        provider: `${providerLabel}-tier${tier}`,
        model: result.model,
        tier,
        tierName: tierNameOf?.(tier) || `tier-${tier}`,
        usage: result.usage || null,
        providerSlug: result.providerSlug || null,
        // C1（2026-09-06）：統一旗標，讓每個消費端不必各自解讀 finish_reason
        finishReason: result.finishReason ?? null,
        truncated: Boolean(result.truncated),
        reasoningExhausted: Boolean(result.reasoningExhausted),
        escalatedReason: escalated
          ? `escalated-from-tier-${startTier}`
          : (typeof contextTokens === 'number' && contextTokens > HEAVY_CONTEXT_TOKENS
            ? 'heavy-context'
            : undefined),
        attempts,
      }
    } catch (e) {
      breakerRecordFailure(key)
      attempts.push({ tier, error: e.message, status: e.status })
      if (tier >= maxTier) {
        const err = new Error(
          `All ${providerLabel} tiers failed (start=${startTier}): ${e.message}`,
        )
        err.attempts = attempts
        err.cause = e
        throw err
      }
    }
  }

  const err = new Error(
    `No available ${providerLabel} tier (start=${startTier}; breakers may be open)`,
  )
  err.attempts = attempts
  throw err
}
