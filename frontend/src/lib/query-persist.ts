// Lightweight localStorage snapshot for the SCM document-list queries, modelled
// on HOOKKA's cached-fetch layer: render the last-known list INSTANTLY on a cold
// open (fresh session / full reload / PWA reopen) and revalidate in the
// background — no full-load spinner. react-query's in-memory cache already makes
// warm re-visits instant; this survives a reload, which the in-memory cache does
// not.
//
// HOOKKA guardrails baked in:
//   - Per-BUILD namespace (bug 1b/2f): the key carries __BUILD_ID__ so a deploy
//     that changes a list's payload SHAPE can't hydrate the previous build's
//     shape; old-build snapshots are pruned on boot.
//   - Per-SESSION namespace (off-not-hide, 2026-07-16): the key also carries a
//     fingerprint of the bearer TOKEN, so one user's snapshot can never hydrate
//     into another user's session. Without this the snapshot was keyed by build +
//     company ONLY, so signing out of an admin account and signing in as a
//     restricted one on the same browser hydrated the ADMIN's rows — the list
//     painted them, then the scoped refetch removed them (render-then-hide).
//   - Logged-out browsers hold NO snapshot: with no token we prune and never
//     hydrate, so business rows don't sit at rest after sign-out.
//   - Never trusted as fresh: hydrated data is stamped stale so the first mount
//     always refetches (cache-while-revalidate).
//   - Whitelisted to the document LISTS only (not detail / sub-resource queries),
//     size-capped, and fail-soft on quota / corruption.

import type { QueryClient } from "@tanstack/react-query";
import { tokenStore } from "../api/client";

// Injected at build time by vite.config `define`. Unique per deploy.
declare const __BUILD_ID__: string;
const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";
const NS_PREFIX = "houzs-rq-snapshot:";
const BUILD_PREFIX = `${NS_PREFIX}${BUILD_ID}:`;
const MAX_BYTES = 1_500_000; // ~1.5 MB — skip the write if the snapshot exceeds it
const DEBOUNCE_MS = 1200;

// The snapshot is namespaced by BUILD (payload-shape drift, HOOKKA bug 1b/2f) AND
// by ACTIVE COMPANY — a cold open after switching company must NOT hydrate the
// other company's list (multi-company isolation). Both are read at call time
// because the active company can change during a session.
function activeCompany(): string {
  try {
    const raw = localStorage.getItem("houzs.activeCompanyId");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? String(n) : "0";
  } catch {
    return "0";
  }
}
// Identity fingerprint for the CURRENT session. The bearer token is the only
// identity signal available synchronously at module-init time (hydrate runs
// before the first render, long before /auth/me resolves), and it already lives
// in the same storage — so a non-reversible short hash of it adds no exposure
// while making the namespace change the moment the signed-in user changes.
// Empty string when signed out.
function sessionFp(): string {
  let token = "";
  try {
    token = tokenStore.get();
  } catch {
    return "";
  }
  if (!token) return "";
  // djb2 — we need a stable bucket per token, not cryptographic strength.
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Prefix owned by the CURRENT build + signed-in session (all companies). */
function sessionPrefix(): string {
  return `${BUILD_PREFIX}${sessionFp()}:`;
}

function snapKey(): string {
  return `${sessionPrefix()}${activeCompany()}`;
}

/** Drop every snapshot this module owns, across all builds/sessions/companies. */
export function clearQuerySnapshots(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // storage disabled / quota — nothing to clear.
  }
}

// The SCM document LIST query entities (first key segment). Detail queries use a
// distinct entity name ('*-detail') and are excluded automatically.
const LIST_ENTITIES = new Set([
  "mfg-sales-orders",
  "mfg-purchase-orders",
  "mfg-delivery-orders",
  "sales-invoices",
  "grns",
]);
// Sub-resource queries share a list entity's prefix but must NOT be persisted.
const SUBRESOURCE = new Set([
  "debtors",
  "deliverable-so-lines",
  "outstanding-po-items",
  "outstanding-so-items",
  "payments",
  "detail",
]);

function isListKey(key: readonly unknown[]): boolean {
  if (key.length < 2) return false;
  const entity = key[0];
  const second = key[1];
  if (typeof entity !== "string" || !LIST_ENTITIES.has(entity)) return false;
  /* Match the sub-resource name ANYWHERE in the key, not just at segment 1.
     The rule above ("must NOT be persisted") was already the intent; the test
     was `SUBRESOURCE.has(key[1])`, and the three PAYMENT LEDGERS put the id
     there instead — ['mfg-delivery-orders', <uuid>, 'payments'],
     ['mfg-sales-orders', <docNo>, 'payments'], ['sales-invoices', <uuid>,
     'payments'] — so every one of them passed the guard and was written to
     localStorage, then rehydrated (stamped updatedAt:1) on the next cold open.
     That put a PAYMENT LEDGER OF UNKNOWN AGE on disk and handed it back as
     query `data` — indistinguishable, to a reader, from a fresh successful
     read. MobilePOD turns exactly that data into the balance a driver
     collects, so a snapshot taken before the customer paid at the office could
     re-present a settled balance as outstanding while the real fetch was still
     in flight (fix/pod-balance, 2026-07-17).
     Scanning every segment cannot over-reject: SUBRESOURCE holds fixed
     sub-names, and the real list keys' other segments are statuses, 'all', or
     ids — none of which collide. ['mfg-purchase-orders', status, supplierId]
     is a LEGITIMATE 3-segment list key and still persists, which is why this
     is a name scan and not a length cap. */
  if (typeof second !== "string") return false;
  if (key.some((seg) => typeof seg === "string" && SUBRESOURCE.has(seg))) return false;
  return true;
}

/** Serialize the whitelisted list queries to localStorage. */
function save(qc: QueryClient): void {
  // Signed out → never write. Otherwise a sign-out mid-debounce would persist the
  // outgoing user's rows under the anonymous key.
  if (!sessionFp()) return;
  try {
    const out: Record<string, unknown> = {};
    for (const q of qc.getQueryCache().getAll()) {
      if (q.state.status !== "success" || q.state.data == null) continue;
      if (!isListKey(q.queryKey as readonly unknown[])) continue;
      out[JSON.stringify(q.queryKey)] = q.state.data;
    }
    const json = JSON.stringify(out);
    if (json.length > MAX_BYTES) return;
    localStorage.setItem(snapKey(), json);
  } catch {
    // quota exceeded / serialization error → skip this write.
  }
}

/** Seed the cache from the last snapshot, stamped stale so it revalidates. */
function hydrate(qc: QueryClient): void {
  // Signed out → hold nothing at rest and hydrate nothing.
  if (!sessionFp()) {
    clearQuerySnapshots();
    return;
  }
  try {
    // Prune every snapshot not owned by the current BUILD + SESSION: an old
    // payload shape must never linger, and another user's rows must never be
    // hydratable. Keep this session's per-company snapshots so switching company
    // and back is still instant. This also self-heals a browser already carrying
    // a pre-fix (build+company-only) snapshot — it simply doesn't match.
    const keep = sessionPrefix();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS_PREFIX) && !k.startsWith(keep)) localStorage.removeItem(k);
    }
    const raw = localStorage.getItem(snapKey());
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [keyStr, data] of Object.entries(obj)) {
      let key: unknown[];
      try {
        key = JSON.parse(keyStr) as unknown[];
      } catch {
        continue;
      }
      if (!Array.isArray(key) || !isListKey(key)) continue;
      // updatedAt in the distant past → stale on first mount, so react-query
      // renders this snapshot instantly (no spinner) and refetches in the
      // background, replacing it with fresh data. Never treated as fresh.
      qc.setQueryData(key, data, { updatedAt: 1 });
    }
  } catch {
    // Corrupt snapshot → ignore and start clean.
  }
}

/** Wire persistence: hydrate now (before first render) + save on cache changes. */
export function installQueryPersist(qc: QueryClient): void {
  if (typeof window === "undefined" || !("localStorage" in window)) return;
  hydrate(qc);
  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      save(qc);
    }, DEBOUNCE_MS);
  };
  qc.getQueryCache().subscribe(schedule);
  // Flush the latest state when the tab is hidden/closed so a snapshot taken
  // <DEBOUNCE_MS after the last change isn't lost.
  window.addEventListener("pagehide", () => save(qc));
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save(qc);
  });
}
