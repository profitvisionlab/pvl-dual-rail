// Dual-rail policy: which path may see which data.
//
// Rails:
//   finops     — cost-optimized external (OpenRouter Tri-Tier). Public / published only.
//   enterprise — boundary-bound generation (Vertex / Gemini Enterprise). Internal OK.
//
// Hard rule (enforced in code, not just docs):
//   internalContext === true  ⇒  never call finops, even if caller asks for it.

export const RAILS = Object.freeze(['finops', 'enterprise'])

/**
 * @param {object} opts
 * @param {'finops'|'enterprise'} [opts.rail] - explicit rail
 * @param {'public'|'published'|'internal'} [opts.sensitivity='public']
 * @param {boolean} [opts.internalContext=false] - true when payload includes internal/private chunks
 * @returns {{ rail: 'finops'|'enterprise', reason: string, forced: boolean }}
 */
export function resolveRail({
  rail,
  sensitivity = 'public',
  internalContext = false,
} = {}) {
  // Absolute gate: internal chunks never leave on the FinOps rail.
  if (internalContext) {
    if (rail === 'finops') {
      const err = new Error(
        'dual-rail policy: internalContext=true forbids rail=finops (internal chunks must not leave the enterprise boundary)',
      )
      err.code = 'DUAL_RAIL_INTERNAL_ON_FINOPS'
      throw err
    }
    return { rail: 'enterprise', reason: 'internal-context', forced: true }
  }

  if (rail === 'finops' || rail === 'enterprise') {
    return { rail, reason: 'explicit', forced: false }
  }

  if (sensitivity === 'internal') {
    return { rail: 'enterprise', reason: 'sensitivity-internal', forced: true }
  }

  // published / public → FinOps by default (cost path). Callers may still pass rail=enterprise.
  return { rail: 'finops', reason: `sensitivity-${sensitivity || 'public'}`, forced: false }
}

/**
 * Quick check used by smoke tests / callers before building prompts.
 * @returns {boolean} true if finops is allowed for this call shape
 */
export function finopsAllowed({ rail, sensitivity, internalContext } = {}) {
  try {
    return resolveRail({ rail, sensitivity, internalContext }).rail === 'finops'
  } catch {
    return false
  }
}
