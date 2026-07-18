// ---------------------------------------------------------------------------
// assistant-scope.ts — who may ask the Assistant what, and which numbers reach
// the model at all.
//
// The Assistant is owner-only today (requirePermission("*")) for one reason: the
// specialists' briefs carry margin and per-salesperson performance, and a single
// prompt would hand those to anyone who could open the page. This module is the
// part that has to exist BEFORE it can be opened to staff.
//
// TWO AXES, and the second is the one that matters:
//   1. CAPABILITY — which specialists a caller may consult at all.
//   2. FIELD — which numbers survive into the payload.
//
// Redaction happens at GATHER, before the model is called. Showing a model the
// margin and instructing it not to repeat the margin is not a control; it is a
// request. A number the caller may not see must never enter the context window,
// because prompt text is advisory and a context window is not.
//
// NO NEW POLICY IS INVENTED HERE. The three flags come from positionPolicy, which
// the owner already approved and which every other surface obeys — this file
// applies them to a new surface rather than authoring a second rulebook. That
// matters: a second rulebook is how "Sales cannot see margin" ends up true on four
// screens and false on the fifth.
// ---------------------------------------------------------------------------

/** The caller's visibility, taken from positionPolicy — not re-derived here. */
export interface AssistantScope {
  /** Wildcard/owner. Sees everything; still passes through the same code path. */
  wildcard?: boolean;
  canSeeMargin: boolean;
  canSeeCommission: boolean;
  /** 'all' = whole company, 'own_downline' = their own reporting line only. */
  orderScope: 'all' | 'own_downline' | 'own';
}

/** Capability keys whose entire subject is money the caller may not be entitled
 *  to. Gated wholesale, because redacting the numbers out of a receivables brief
 *  leaves a brief about nothing. */
const CAPABILITY_REQUIREMENTS: Record<string, (s: AssistantScope) => boolean> = {
  // "Who owes us money" is a finance view. Margin visibility is the existing proxy
  // for finance-grade access in positionPolicy.
  receivables: (s) => s.canSeeMargin,
  // Commercial intelligence IS margin + per-salesperson performance.
  sales_intel: (s) => s.canSeeMargin || s.canSeeCommission,
};

/**
 * Field names that must not reach the model for a caller without the matching
 * flag. Matched case-insensitively on the KEY, at any depth.
 *
 * Deliberately a DENYLIST of concepts rather than an allowlist of fields: the
 * briefs are free-form JSON written by six different agents, so an allowlist would
 * silently drop new legitimate fields and make the Assistant useless, while this
 * list fails toward hiding. Where the two disagree, hiding a number the caller
 * could have seen is a complaint; showing one they could not is a leak.
 */
const MARGIN_KEYS = /(margin|gross_?profit|grossProfit|profit|cost_?centi|costCenti|unit_?cost|unitCost|landed_?cost|markup)/i;
const COMMISSION_KEYS = /(commission|payout|incentive)/i;

/** Value substituted for a redacted number — visible, not silently dropped, so an
 *  answer built on it can say "hidden" rather than "zero". A missing key would let
 *  the model treat the figure as absent and reason as if it were nil. */
export const REDACTED = '[hidden for your role]';

export function isCapabilityAllowed(key: string, scope: AssistantScope): boolean {
  if (scope.wildcard) return true;
  const req = CAPABILITY_REQUIREMENTS[key];
  return req ? req(scope) : true;
}

export function allowedCapabilityKeys(keys: readonly string[], scope: AssistantScope): string[] {
  return keys.filter((k) => isCapabilityAllowed(k, scope));
}

/**
 * Deep-redact a gathered payload in place-free fashion (returns a new value).
 * Arrays and nested objects are walked; scalars are returned as-is.
 */
export function redactFacts<T>(facts: T, scope: AssistantScope): T {
  if (scope.wildcard) return facts;
  const hideMargin = !scope.canSeeMargin;
  const hideCommission = !scope.canSeeCommission;
  if (!hideMargin && !hideCommission) return facts;

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if ((hideMargin && MARGIN_KEYS.test(k)) || (hideCommission && COMMISSION_KEYS.test(k))) {
          out[k] = REDACTED;
          continue;
        }
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(facts) as T;
}

/** A one-line note appended to the model's instructions so an answer built on a
 *  redacted payload says so, instead of quietly reporting less than it knows. */
export function scopeNote(scope: AssistantScope): string | null {
  if (scope.wildcard) return null;
  const hidden: string[] = [];
  if (!scope.canSeeMargin) hidden.push('margin and cost figures');
  if (!scope.canSeeCommission) hidden.push('commission figures');
  if (hidden.length === 0) return null;
  return `Some values are marked "${REDACTED}" because this user's role does not include ${hidden.join(' or ')}. Never guess or reconstruct a hidden value; say it is not available to them.`;
}
