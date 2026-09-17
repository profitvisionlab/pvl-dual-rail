// Dual-rail chatComplete — shared Tri-Tier brain + policy gate + adapters.
//
//   rail=finops     → 依 DUAL_RAIL_FINOPS_CHAIN 依序嘗試（預設 together,openrouter）。
//                     Public / published only.
//   rail=enterprise → Vertex Gemini (boundary). Required when internalContext.
//
// 2026-09-07 Ben 定案：**NVIDIA NIM 除役**，FinOps 軌改以 Together 為主力。
// 同日定案三家依任務派工：Together（主）、DeepInfra（同款模型備援／長前綴）、
// Lightning（前沿模型／最後備援）。0.3.0 起 chain 可設定，但**預設維持
// together,openrouter** —— 換 chain 是營運決策，要有金鑰與實打結果才改。
//
// NIM adapter 的程式碼保留在 git 歷史，不留在供應鏈上——留著一個沒有金鑰、
// 每次呼叫都被記成 skipped 的供應商，只會讓日誌多一行永遠成立的雜訊。
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
  callDeepInfra,
  listDeepInfraModels,
  deepInfraTierName,
  isDeepInfraConfigured,
} from './adapters/deepinfra.mjs'
import {
  callLightning,
  listLightningModels,
  lightningTierName,
  isLightningConfigured,
} from './adapters/lightning.mjs'
import {
  callOpenAI,
  listOpenAIModels,
  openAITierName,
  isOpenAIConfigured,
} from './adapters/openai.mjs'
import {
  callOpenRouter,
  listFinopsModels,
  finopsTierName,
  isFinopsConfigured,
} from './adapters/openrouter.mjs'
import {
  assertNoToolsForEnterprise,
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
  isDeepInfraConfigured,
  isLightningConfigured,
  isOpenAIConfigured,
  isFinopsConfigured,
  isEnterpriseConfigured,
  isEnterpriseMock,
}

/**
 * FinOps 供應商登錄表。chain 裡的名稱必須是這裡的 key。
 * envVar 是「沒設就跳過」判斷用的金鑰名稱，也會出現在 attempts 裡。
 */
const FINOPS_PROVIDERS = {
  together: {
    envVar: 'TOGETHER_API_KEY',
    configured: isTogetherConfigured,
    listModels: listTogetherModels,
    tierNameOf: togetherTierName,
    call: callTogether,
  },
  deepinfra: {
    envVar: 'DEEPINFRA_API_KEY',
    configured: isDeepInfraConfigured,
    listModels: listDeepInfraModels,
    tierNameOf: deepInfraTierName,
    call: callDeepInfra,
  },
  lightning: {
    envVar: 'LIGHTNING_API_KEY',
    configured: isLightningConfigured,
    listModels: listLightningModels,
    tierNameOf: lightningTierName,
    call: callLightning,
  },
  openai: {
    envVar: 'OPENAI_API_KEY',
    configured: isOpenAIConfigured,
    listModels: listOpenAIModels,
    tierNameOf: openAITierName,
    call: callOpenAI,
  },
  openrouter: {
    envVar: 'OPENROUTER_API_KEY',
    configured: isFinopsConfigured,
    listModels: listFinopsModels,
    tierNameOf: finopsTierName,
    call: callOpenRouter,
  },
}

export const DEFAULT_FINOPS_CHAIN = Object.freeze(['together', 'openrouter'])

/**
 * 解析 DUAL_RAIL_FINOPS_CHAIN（逗號分隔、不分大小寫、重複的只留第一個）。
 * 未設定＝預設 together,openrouter。寫錯名字直接丟 DUAL_RAIL_BAD_CHAIN：
 * 打錯字若被靜默忽略，chain 會少一家而沒人發現，直到那一家剛好是唯一活著的。
 */
export function resolveFinopsChain(raw = process.env.DUAL_RAIL_FINOPS_CHAIN) {
  if (raw == null || String(raw).trim() === '') return DEFAULT_FINOPS_CHAIN.slice()
  const names = [...new Set(String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]
  const unknown = names.filter((n) => !FINOPS_PROVIDERS[n])
  if (unknown.length || !names.length) {
    const err = new Error(
      `DUAL_RAIL_FINOPS_CHAIN 無效（${unknown.length ? `不認得：${unknown.join(', ')}` : '清單是空的'}）；` +
        `可用：${Object.keys(FINOPS_PROVIDERS).join(', ')}`,
    )
    err.code = 'DUAL_RAIL_BAD_CHAIN'
    throw err
  }
  return names
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
 * @param {'realtime'|'batch'} [opts.mode='realtime'] - OpenRouter provider sort only
 * @param {object[]} [opts.tools] - OpenAI function 格式，原樣送給 finops adapter；enterprise 軌丟 DUAL_RAIL_TOOLS_UNSUPPORTED
 * @param {string|object} [opts.toolChoice] - 對應 tool_choice（'auto'／'none'／'required'／{type:'function',function:{name}}）
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
  tools,
  toolChoice,
} = {}) {
  // 政策閘門永遠第一個跑：tools 等功能參數不得影響 rail 判定
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
    // ── FinOps 軌：依 chain 順序嘗試（預設 Together 主 → OpenRouter 備援）──────
    // 後面的供應商只在前面的斷線、限流或斷路器跳開時接手，那是降級，
    // 所以回傳值會標 fellBack，讓呼叫端與日誌看得出來「為什麼換了供應商」，
    // 不是只看到換了供應商這個結果。
    const chain = resolveFinopsChain()
    const providers = chain.map((name) => ({ name, ...FINOPS_PROVIDERS[name] }))

    if (!providers.some((p) => p.configured())) {
      const err = new Error(
        `FinOps rail selected but no provider in chain [${chain.join(',')}] is configured ` +
          `(set one of: ${providers.map((p) => p.envVar).join(', ')})`,
      )
      err.code = 'DUAL_RAIL_FINOPS_UNCONFIGURED'
      err.attempts = providers.map((p) => ({ provider: p.name, skipped: 'not-configured', envVar: p.envVar }))
      throw err
    }

    const callArgs = { system, messages, maxTokens, json, mode, tools, toolChoice }
    const runOn = (p) =>
      runTier({
        listModels: p.listModels,
        callTier: ({ models, ...rest }) =>
          p.call({
            models,
            system: rest.system,
            messages: rest.messages,
            maxTokens: rest.maxTokens,
            json: rest.json,
            mode: rest.mode,
            tools: rest.tools,
            toolChoice: rest.toolChoice,
          }),
        callArgs,
        tierNameOf: p.tierNameOf,
        startTier,
        escalate,
        contextTokens,
        breakerPrefix: `finops-${p.name}`,
        providerLabel: p.name,
      })

    const base = { rail: 'finops', railReason: decision.reason, railForced: decision.forced, finopsChain: chain }

    // 「沒設定」與「試了但失敗」要分開記：只有後者算降級。
    // 混在一起的話，沒設備援金鑰時每一次正常的主力呼叫都會被標成
    // 「降級」—— 日誌看起來像天天在降級，真正的降級反而被淹沒。
    // 這與 buyerKb/retrieve.ts 移除那個永遠成立的 fallback 是同一條理由：
    // 降級要能被區分成「暫時性」與「設定就是這樣」。
    //
    // 供應商層級的紀錄（skipped／error）依 chain 順序放在 attempts 前段，
    // 後面接成功那一家的 tier 層級紀錄。
    const skipped = []
    const failed = []
    const providerAttempts = []
    for (const p of providers) {
      if (!p.configured()) {
        skipped.push({ name: p.name, error: `${p.envVar} not set` })
        providerAttempts.push({ provider: p.name, skipped: 'not-configured', envVar: p.envVar })
        continue
      }
      try {
        const result = await runOn(p)
        return {
          ...result,
          ...base,
          attempts: [...providerAttempts, ...(result.attempts || []).map((a) => ({ provider: p.name, ...a }))],
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
        const error = e?.message ?? String(e)
        failed.push({ name: p.name, error })
        providerAttempts.push({
          provider: p.name,
          error,
          ...(e?.code || e?.cause?.code ? { code: e.code || e.cause.code } : {}),
          ...(Array.isArray(e?.attempts) ? { tiers: e.attempts } : {}),
        })
      }
    }
    const attempted = [...failed, ...skipped]

    const err = new Error(
      `All finops providers failed/unconfigured: ${attempted.map((a) => `${a.name}: ${a.error}`).join(' | ')}`,
    )
    err.code = 'DUAL_RAIL_FINOPS_EXHAUSTED'
    err.attempts = providerAttempts
    throw err
  }

  // enterprise
  // 工具呼叫在 enterprise 軌不支援：明確丟錯，**絕不**因此改走 finops
  assertNoToolsForEnterprise({ tools, toolChoice, messages })
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
