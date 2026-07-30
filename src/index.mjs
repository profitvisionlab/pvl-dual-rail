// Dual-rail chatComplete — shared Tri-Tier brain + policy gate + adapters.
//
//   rail=finops     → OpenRouter (cost). Public / published only.
//   rail=enterprise → Vertex Gemini (boundary). Required when internalContext.
//
// PVL.AI semi-open unit: https://github.com/sharemo168-hub/pvl-dual-rail

import { resolveRail } from './policy.mjs'
import {
  resolveTier,
  runTier,
  getCircuitBreakerStatus,
  resetCircuitBreakers,
  HEAVY_CONTEXT_TOKENS,
} from './router.mjs'
import {
  callOpenRouter,
  listFinopsModels,
  finopsTierName,
  isFinopsConfigured,
} from './adapters/openrouter.mjs'
import {
  callEnterprise,
  listEnterpriseModels,
  enterpriseTierName,
  isEnterpriseConfigured,
  isEnterpriseMock,
} from './adapters/enterprise.mjs'

export {
  resolveRail,
  resolveTier,
  getCircuitBreakerStatus,
  resetCircuitBreakers,
  HEAVY_CONTEXT_TOKENS,
  isFinopsConfigured,
  isEnterpriseConfigured,
  isEnterpriseMock,
}

/**
 * Build a system message shaped for Anthropic-style prompt caching via OpenRouter.
 */
export function buildCachedSystem(staticPrefix, dynamicTail = '', { enableCache = true } = {}) {
  if (!enableCache || !staticPrefix) {
    return dynamicTail ? `${staticPrefix}\n\n${dynamicTail}` : staticPrefix
  }
  const blocks = [
    {
      type: 'text',
      text: staticPrefix,
      cache_control: { type: 'ephemeral' },
    },
  ]
  if (dynamicTail) blocks.push({ type: 'text', text: dynamicTail })
  return blocks
}

export function listTierModels(tier, rail = 'finops') {
  return rail === 'enterprise' ? listEnterpriseModels(tier) : listFinopsModels(tier)
}

/**
 * @param {object} opts
 * @param {'finops'|'enterprise'} [opts.rail]
 * @param {'public'|'published'|'internal'} [opts.sensitivity='public']
 * @param {boolean} [opts.internalContext=false]
 * @param {'realtime'|'batch'} [opts.mode='realtime'] - FinOps provider sort only
 */
export async function chatComplete({
  system,
  messages,
  maxTokens = 1200,
  contextTokens,
  task,
  tier: tierOpt,
  mode = 'realtime',
  json = false,
  escalate = true,
  rail: railOpt,
  sensitivity = 'public',
  internalContext = false,
} = {}) {
  const decision = resolveRail({ rail: railOpt, sensitivity, internalContext })
  const startTier = resolveTier({ tier: tierOpt, task, contextTokens })

  if (decision.rail === 'finops') {
    if (!isFinopsConfigured()) {
      throw new Error('FinOps rail selected but OPENROUTER_API_KEY missing')
    }
    const result = await runTier({
      listModels: listFinopsModels,
      callTier: ({ models, ...rest }) => callOpenRouter({
        models,
        system: rest.system,
        messages: rest.messages,
        maxTokens: rest.maxTokens,
        json: rest.json,
        mode: rest.mode,
      }),
      callArgs: { system, messages, maxTokens, json, mode },
      tierNameOf: finopsTierName,
      startTier,
      escalate,
      contextTokens,
      breakerPrefix: 'finops',
      providerLabel: 'openrouter',
    })
    return {
      ...result,
      rail: 'finops',
      railReason: decision.reason,
      railForced: decision.forced,
    }
  }

  // enterprise
  if (!isEnterpriseConfigured()) {
    const err = new Error(
      'Enterprise rail selected but not configured (set VERTEX_PROJECT_ID + VERTEX_ACCESS_TOKEN, or ENTERPRISE_ADAPTER=mock)',
    )
    err.code = 'ENTERPRISE_NOT_CONFIGURED'
    throw err
  }

  const result = await runTier({
    listModels: listEnterpriseModels,
    callTier: ({ models, ...rest }) => callEnterprise({
      models,
      system: rest.system,
      messages: rest.messages,
      maxTokens: rest.maxTokens,
      json: rest.json,
    }),
    callArgs: { system, messages, maxTokens, json },
    tierNameOf: enterpriseTierName,
    startTier,
    escalate,
    contextTokens,
    breakerPrefix: 'enterprise',
    providerLabel: 'vertex',
  })
  return {
    ...result,
    rail: 'enterprise',
    railReason: decision.reason,
    railForced: decision.forced,
  }
}
