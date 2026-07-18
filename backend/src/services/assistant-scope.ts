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

/**
 * Positions with NO Assistant access at all (owner, 2026-07-18: "開放給operation
 * 除了driver helper storekeeper").
 *
 * These are the field crew. They hold a phone on a lorry, not a desk — the
 * Assistant answers planning questions they are not the ones to act on, and their
 * own job list is already the Delivery Planning board scoped to them
 * (lib/deliveryScope.ts). Denying the whole surface is simpler and more honest
 * than serving them an assistant that can answer almost nothing.
 *
 * EXACTLY the three the owner named. NOT "Storekeeper Supervisor" — that is a
 * fourth position in positionPolicy's restricted cohort, and he listed three, so
 * the Supervisor keeps access. Add the string here to change that; it is one line
 * and deliberately not my call.
 *
 * Matched on the EXACT normalised name, never a substring: `Storekeeper`
 * would swallow "Storekeeper Supervisor", and a word-boundary regex on a free-text
 * position name is how a RENAME silently moves permissions (BUG-HISTORY,
 * 2026-07-18 — it has already happened twice in this codebase).
 */
export const ASSISTANT_DENIED_POSITIONS: ReadonlySet<string> = new Set([
  'driver',
  'helper',
  'storekeeper',
]);

const normalisePosition = (n: string | null | undefined): string =>
  String(n ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * May this user open the Assistant at all?
 *
 * A wildcard holder always may. Everyone else is allowed UNLESS their position is
 * on the deny list — allow-by-default, matching the surface being open to staff.
 * A user with no position is ALLOWED here (they simply get the money-hidden scope);
 * the deny list is about a named job, not about missing data.
 */
export function canUseAssistant(
  user: { permissions?: unknown; position_name?: string | null } | null | undefined,
): boolean {
  const perms = user?.permissions;
  const isWildcard = Array.isArray(perms)
    ? perms.includes('*')
    : typeof perms === 'string' && perms.trim() === '*';
  if (isWildcard) return true;
  return !ASSISTANT_DENIED_POSITIONS.has(normalisePosition(user?.position_name));
}

/**
 * Derive a caller's scope from the ONE policy, never from a fresh rule.
 *
 * Three cases, and the third is the one that needs stating:
 *   • wildcard (`*`)         → sees everything, as everywhere else.
 *   • a positioned user      → positionPolicy's flags VERBATIM. Note this honours
 *                              the owner's default-FULL model: an unclassified
 *                              position sees money, because that is his ruling
 *                              ("暂时都可以看到系统里的所有内容") and this surface
 *                              must not be quietly stricter than every other one.
 *   • NO position at all     → money hidden. Not a policy disagreement: the policy
 *                              has no input to decide from, and "we cannot tell"
 *                              must not resolve to "entitled". Defaulting the
 *                              unknown to permissive is how `?? 0` style bugs
 *                              become disclosures.
 */
export function scopeForUser(
  user: { permissions?: unknown; position_name?: string | null; department_name?: string | null } | null | undefined,
  resolve: (i: { position_name: string | null; department_name: string | null }) => {
    flags: { canSeeMargin: boolean; canSeeCommission: boolean; orderScope: 'own_downline' | 'all' };
  } | null,
): AssistantScope {
  const perms = user?.permissions;
  const isWildcard = Array.isArray(perms)
    ? perms.includes('*')
    : typeof perms === 'string' && perms.trim() === '*';
  if (isWildcard) return { wildcard: true, canSeeMargin: true, canSeeCommission: true, orderScope: 'all' };

  const position = user?.position_name ?? null;
  if (!position) {
    return { canSeeMargin: false, canSeeCommission: false, orderScope: 'own' };
  }
  const policy = resolve({ position_name: position, department_name: user?.department_name ?? null });
  if (!policy) return { canSeeMargin: false, canSeeCommission: false, orderScope: 'own' };
  return {
    canSeeMargin: policy.flags.canSeeMargin,
    canSeeCommission: policy.flags.canSeeCommission,
    orderScope: policy.flags.orderScope,
  };
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
