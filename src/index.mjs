// Dual-rail chatComplete — shared Tri-Tier brain + policy gate + adapters.
//
//   rail=finops     → Together（主）／OpenRouter（備援）。Public / published only.
//   rail=enterprise → Vertex Gemini (boundary). Required when internalContext.
//
// 2026-09-07 Ben 定案：**NVIDIA NIM 除役**，FinOps 軌改以 Together 為主力，
// OpenRouter 為唯一備援（Together 斷線／限流／斷路器跳開時才接手）。
// 除役理由見 README「Provider chain」；NIM adapter 的程式碼保留在 git 歷史，
// 不留在供應鏈上——留著一個沒有金鑰、每次呼叫都被記成 skipped 的供應商，
// 只會讓日誌多一行永遠成立的雜訊。
//
// PVL.AI semi-open unit: https://github.com/profitvisionlab/pvl-dual-rail

import { resolveRail } from './policy.mjs'
import { envInt } from './env.mjs'
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
  // DUAL_RAIL_FORCE_TIER：把整條 finops 軌釘在某一層，蓋過 task 對應與
  // contextTokens 啟發式。
  //
  // 🔴 **預設就該是沒有設定。** 它原本的理由是 NIM 免費期內讓旗艦吃真實流量；
  // NIM 已於 2026-09-07 除役，那個理由消失了。在 Together 上釘 tier3 等於
  // 每個輕量任務都付旗艦價——要用它必須有當下的、寫下來的理由。
  // enterprise 軌不受影響（它有自己的成本結構與合規理由）。
  const forced = decision.rail === 'finops' ? envInt('DUAL_RAIL_FORCE_TIER', null) : null
  const startTier = resolveTier({
    tier: (forced === 1 || forced === 2 || forced === 3) ? forced : tierOpt,
    task,
    contextTokens,
  })

  if (decision.rail === 'finops') {
    // ── FinOps 軌：Together 主 → OpenRouter 備援（2026-09-07 起）────────────
    // OpenRouter 只在 Together 斷線、限流或斷路器跳開時接手，那是降級，
    // 所以回傳值會標 fellBack，讓呼叫端與日誌看得出來「為什麼換了供應商」，
    // 不是只看到換了供應商這個結果。
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

    const providers = [
      { name: 'together', envVar: 'TOGETHER_API_KEY', configured: isTogetherConfigured(), run: runOnTogether },
      { name: 'openrouter', envVar: 'OPENROUTER_API_KEY', configured: isFinopsConfigured(), run: runOnOpenRouter },
    ]

    // 「沒設定」與「試了但失敗」要分開記：只有後者算降級。
    // 混在一起的話，沒設 OpenRouter 金鑰時每一次正常的 Together 呼叫都會被標成
    // 「降級」—— 日誌看起來像天天在降級，真正的降級反而被淹沒。
    // 這與 buyerKb/retrieve.ts 移除那個永遠成立的 fallback 是同一條理由：
    // 降級要能被區分成「暫時性」與「設定就是這樣」。
    const skipped = []
    const failed = []
    for (const p of providers) {
      if (!p.configured) {
        skipped.push({ name: p.name, error: `${p.envVar} not set` })
        continue
      }
      try {
        const result = await p.run()
        return {
          ...result,
          ...base,
          ...(failed.length
            ? {
                fellBack: true,
                fallbackFrom: failed[0].name,
                fallbackChain: failed.map((a) => a.name),
                fallbackReason: failed[failed.length - 1].error,
              }
            : {}),
          ...(skipped.length ? { skippedProviders: skipped.map((s) => s.name) } : {}),
        }
      } catch (e) {
        failed.push({ name: p.name, error: e?.message ?? String(e) })
      }
    }
    const attempted = [...failed, ...skipped]

    throw new Error(
      `All finops providers failed/unconfigured: ${attempted.map((a) => `${a.name}: ${a.error}`).join(' | ')}`,
    )
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
