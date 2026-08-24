// Dual-rail chatComplete — shared Tri-Tier brain + policy gate + adapters.
//
//   rail=finops     → Together.AI（主）／OpenRouter（備援）。Public / published only.
//   rail=enterprise → Vertex Gemini (boundary). Required when internalContext.
//
// FinOps 軌自 2026-08-13 起以 Together 為主要供應商，OpenRouter 降為備援。
// 理由見 adapters/together.mjs 檔頭：聚合層無法控制資料落地的司法管轄。
//
// PVL.AI semi-open unit: https://github.com/profitvisionlab/pvl-dual-rail

import { resolveRail } from './policy.mjs'
import {
  resolveTier,
  runTier,
  getCircuitBreakerStatus,
  resetCircuitBreakers,
  HEAVY_CONTEXT_TOKENS,
} from './router.mjs'
import {
  callTogether,
  listTogetherModels,
  togetherTierName,
  isTogetherConfigured,
} from './adapters/together.mjs'
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
  isTogetherConfigured,
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
    // ── FinOps 軌：Together 主、OpenRouter 備援 ──────────────────────────
    // 聚合層會自行挑選下游供應商，資料實際落在哪個機房、受哪一國法域管轄
    // 都不可控。直連單一供應商只有一個對手方，資料路徑是已知的。
    // 保留 OpenRouter 為備援而非移除 —— 單一供應商全掛時仍要有出路，
    // 但那是降級，所以回傳值會標 fellBack，讓呼叫端與日誌看得出來。
    if (!isTogetherConfigured() && !isFinopsConfigured()) {
      throw new Error(
        'FinOps rail selected but neither TOGETHER_API_KEY nor OPENROUTER_API_KEY is set',
      )
    }

    const runOnTogether = () =>
      runTier({
        listModels: listTogetherModels,
        callTier: ({ models, ...rest }) =>
          callTogether({
            models,
            system: rest.system,
            messages: rest.messages,
            maxTokens: rest.maxTokens,
            json: rest.json,
          }),
        callArgs: { system, messages, maxTokens, json },
        tierNameOf: togetherTierName,
        startTier,
        escalate,
        contextTokens,
        // 斷路器分開計數：Together 跳開不該連帶把 OpenRouter 也算成失敗
        breakerPrefix: 'finops-together',
        providerLabel: 'together',
      })

    const runOnOpenRouter = () =>
      runTier({
        listModels: listFinopsModels,
        callTier: ({ models, ...rest }) =>
          callOpenRouter({
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
        breakerPrefix: 'finops-openrouter',
        providerLabel: 'openrouter',
      })

    const base = { rail: 'finops', railReason: decision.reason, railForced: decision.forced }

    if (isTogetherConfigured()) {
      try {
        return { ...(await runOnTogether()), ...base }
      } catch (togetherErr) {
        if (!isFinopsConfigured()) throw togetherErr
        // 保留原始錯誤：否則事後只看得到「用了 OpenRouter」，
        // 看不出「為什麼降級」，排查時等於沒有線索。
        return {
          ...(await runOnOpenRouter()),
          ...base,
          fellBack: true,
          fallbackFrom: 'together',
          fallbackReason: togetherErr?.message ?? String(togetherErr),
        }
      }
    }

    // 沒設 TOGETHER_API_KEY 才直接用 OpenRouter（過渡期／本機）
    return {
      ...(await runOnOpenRouter()),
      ...base,
      fellBack: true,
      fallbackFrom: 'together',
      fallbackReason: 'TOGETHER_API_KEY not set',
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
