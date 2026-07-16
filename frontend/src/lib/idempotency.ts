// ---------------------------------------------------------------------------
// Idempotency keys for money-mutating requests — the CLIENT half.
//
// backend/src/middleware/idempotency.ts has been mounted on /api/* (after auth,
// so user_id is set) since it was written, with a claim-then-replay store, an
// in-flight 409 and a daily TTL sweep. It is OPT-IN: a pure pass-through unless
// the client sends an `Idempotency-Key` header, and until this module NO client
// ever sent one. A safety feature nobody switched on is not a safety feature —
// every double-fire of a payment write (double tap, flaky-network re-submit,
// an operator re-pressing after a partial failure) booked the money twice.
//
// Two rules. Break EITHER and this is worse than the bug it fixes:
//
//   1. STABLE for a retry. A key minted per click or per render hands the two
//      halves of a double-fire two DIFFERENT keys, and the middleware no-ops.
//      That is a fix that does nothing.
//   2. UNIQUE per intent. A key derived from the payload makes two GENUINE
//      identical payments (the same customer pays RM100 twice today) collide,
//      and the middleware replays the first response verbatim — so the second
//      payment is silently swallowed and the money is never booked, while the
//      operator is told it saved. That is a fix that LOSES money.
//
// So: mint once when the operator STARTS one payment (opens the sheet, adds the
// draft row), reuse it for every retry of that one submit, and let it die with
// the thing that represents the intent — the draft row is removed on success,
// the sheet unmounts on close. The key is retired by the intent ENDING, never by
// the write succeeding; see useIdempotencyKey for why that distinction is load-
// bearing rather than pedantic.
//
// This is deliberately NOT hidden inside authedFetch. Only the call site knows
// where an intent begins and ends: an automatic per-request key would satisfy
// (2) and break (1); an automatic payload-derived key would satisfy (1) and
// break (2). There is no correct automatic key, which is precisely why the
// middleware was built opt-in and precisely why nobody ever opted in.
//
// SCOPE: money only — a call site that creates a payment-ledger row or adds to
// a paid total. NOT a blanket on every POST: plenty of endpoints have
// legitimate repeat-submit semantics, and an endpoint that is already
// domain-idempotent (payment-vouchers.ts:407 /post, :528 /cancel both detect
// their own replay and echo back) gains nothing from a key.
// ---------------------------------------------------------------------------
import { useState } from "react";

/** Mint a key for ONE payment intent. Opaque to the server, which only ever
 *  compares it for equality against the (key, scope) primary key. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // randomUUID needs a secure context. Keep a fallback so a payment can still
  // be recorded from an http:// LAN origin instead of throwing at the mint —
  // failing to mint must never block collecting money.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

/** Merge the key into a fetch init. No key → the init is returned untouched and
 *  the middleware stays a pass-through, i.e. exactly today's behaviour. Keeps
 *  the header name in ONE place so call sites can't misspell it into silence. */
export function idempotentInit(key: string | undefined, init: RequestInit): RequestInit {
  if (!key) return init;
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      "Idempotency-Key": key,
    },
  };
}

/** One intent's key, for a form/sheet whose MOUNT is the intent — the operator
 *  opened it to record ONE payment, and it closes once that payment lands. The
 *  key lives exactly as long as that mount: stable for every retry while the
 *  sheet is open, gone when it closes, so the next payment is a new mount and a
 *  new key. Callers whose intent is a DATA row rather than a mount (a
 *  PaymentsTable draft) should instead mint with newIdempotencyKey() and store
 *  it on the row, which dies with the row on success — same rule, same effect.
 *
 *  There is deliberately no `rotate()`. Retiring the key on success sounds
 *  safer and is not: the only way to reach a second submit is for a step AFTER
 *  the successful post to fail (a refetch on bad signal — the exact scenario
 *  this module exists for), and a rotated key would then book the payment a
 *  SECOND time. Keeping the key means that retry REPLAYS, which is the honest
 *  answer: the operator only ever intended one payment. The key is retired by
 *  the intent ending, never by the write succeeding. */
export function useIdempotencyKey(): string {
  const [key] = useState(newIdempotencyKey);
  return key;
}
