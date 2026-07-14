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
//   - Never trusted as fresh: hydrated data is stamped stale so the first mount
//     always refetches (cache-while-revalidate).
//   - Whitelisted to the document LISTS only (not detail / sub-resource queries),
//     size-capped, and fail-soft on quota / corruption.

import type { QueryClient } from "@tanstack/react-query";

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
function snapKey(): string {
  return `${BUILD_PREFIX}${activeCompany()}`;
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
// Sub-resource queries share a list entity's prefix but must NOT be persisted;
// they are distinguished by a known second segment.
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
  // A list's second segment is a status string ('all' / a status enum). A detail
  // or sub-resource query has an id/number or a known sub-name here instead.
  if (typeof second !== "string" || SUBRESOURCE.has(second)) return false;
  return true;
}

/** Serialize the whitelisted list queries to localStorage. */
function save(qc: QueryClient): void {
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
  try {
    // Prune snapshots from previous BUILDS (an old payload shape must never
    // linger). Keep the current build's per-company snapshots so switching
    // company and back is still instant.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS_PREFIX) && !k.startsWith(BUILD_PREFIX)) localStorage.removeItem(k);
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
