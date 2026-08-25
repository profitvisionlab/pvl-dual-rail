#!/usr/bin/env node
// Verifiable dual-rail smoke — no live network required for policy checks.
// Enterprise path uses ENTERPRISE_ADAPTER=mock.
//
//   npm test
//
// Claims:
//   1) internalContext + rail=finops → rejected (DUAL_RAIL_INTERNAL_ON_FINOPS)
//   2) internalContext alone → enterprise mock succeeds
//   3) sensitivity=published → finops selected by policy
//   4) explicit rail=enterprise → enterprise mock
//   5) sensitivity=internal + rail=finops → rejected (explicit rail is not an opt-out)

process.env.ENTERPRISE_ADAPTER = process.env.ENTERPRISE_ADAPTER || 'mock'

import { fileURLToPath } from 'node:url'
try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))) }
catch { /* optional */ }

import { resolveRail, finopsAllowed } from '../src/policy.mjs'
import { chatComplete, resetCircuitBreakers } from '../src/index.mjs'

const results = []
function ok(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond), detail })
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

resetCircuitBreakers()

let blocked = false
let code = ''
try {
  resolveRail({ rail: 'finops', internalContext: true })
} catch (e) {
  blocked = true
  code = e.code || ''
}
ok('internalContext forbids finops', blocked && code === 'DUAL_RAIL_INTERNAL_ON_FINOPS', code)

const d2 = resolveRail({ internalContext: true })
ok('internalContext → enterprise', d2.rail === 'enterprise' && d2.forced, d2.reason)

const d3 = resolveRail({ sensitivity: 'published' })
ok('published → finops', d3.rail === 'finops', d3.reason)
ok('finopsAllowed(published)', finopsAllowed({ sensitivity: 'published' }))
ok('!finopsAllowed(internal ctx)', !finopsAllowed({ internalContext: true }))

let blockedSens = false
let codeSens = ''
try {
  resolveRail({ rail: 'finops', sensitivity: 'internal' })
} catch (e) {
  blockedSens = true
  codeSens = e.code || ''
}
ok(
  "sensitivity='internal' forbids explicit finops",
  blockedSens && codeSens === 'DUAL_RAIL_INTERNAL_ON_FINOPS',
  codeSens,
)
ok('!finopsAllowed(sensitivity internal)', !finopsAllowed({ sensitivity: 'internal' }))

try {
  const r = await chatComplete({
    system: 'You are a boundary-bound assistant.',
    messages: [{ role: 'user', content: 'INTERNAL memo: Q3 runway is confidential.' }],
    maxTokens: 64,
    internalContext: true,
    tier: 1,
    escalate: false,
  })
  ok(
    'enterprise mock answers internal',
    r.rail === 'enterprise' && r.text.includes('enterprise-mock') && r.provider.startsWith('vertex'),
    `${r.rail} · ${r.model}`,
  )
} catch (e) {
  ok('enterprise mock answers internal', false, e.message)
}

try {
  const r = await chatComplete({
    system: 'ok',
    messages: [{ role: 'user', content: 'ping' }],
    rail: 'enterprise',
    tier: 2,
    escalate: false,
  })
  ok('explicit enterprise rail', r.rail === 'enterprise' && r.railReason === 'explicit', r.tierName)
} catch (e) {
  ok('explicit enterprise rail', false, e.message)
}

if (process.env.NVIDIA_NIM_API_KEY) {
  try {
    const r = await chatComplete({
      system: 'Reply with exactly: pong',
      messages: [{ role: 'user', content: 'ping' }],
      sensitivity: 'public',
      maxTokens: 32,
      tier: 1,
      escalate: true,
    })
    ok('finops live via NIM (optional)', r.rail === 'finops' && r.text.length > 0, `${r.provider} · ${r.model}`)
  } catch (e) {
    ok('finops live via NIM (optional)', false, e.message)
  }
} else {
  ok('finops live via NIM skipped (no NVIDIA_NIM_API_KEY)', true, 'policy-only run')
}

if (process.env.OPENROUTER_API_KEY) {
  try {
    const r = await chatComplete({
      system: 'Reply with exactly: pong',
      messages: [{ role: 'user', content: 'ping' }],
      sensitivity: 'public',
      maxTokens: 32,
      tier: 1,
      escalate: true,
    })
    ok('finops live (optional)', r.rail === 'finops' && r.text.length > 0, `${r.model}`)
  } catch (e) {
    ok('finops live (optional)', false, e.message)
  }
} else {
  ok('finops live skipped (no OPENROUTER_API_KEY)', true, 'policy-only run')
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.error('Failed:', failed.map((f) => f.name).join(', '))
  process.exit(1)
}
