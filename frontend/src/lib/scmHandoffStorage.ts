import { getBrowserStorageIdentity } from "./storageIdentity";

export const SCM_HANDOFF_KEYS = [
  "cnFromOrderPicks",
  "crFromNotePicks",
  "doFromSoPicks",
  "drFromDoPicks",
  "grnFromPoPicks",
  "grnNewDraft",
  "pcrFromOrderPicks",
  "pcrnFromReceivePicks",
  "piFromGrnPicks",
  "poFromSoPicks",
  "poNewDraft",
  "siFromDoPicks",
  "soScanPrefill",
] as const;

export type ScmHandoffKey = (typeof SCM_HANDOFF_KEYS)[number];

export const SCM_HANDOFF_VERSION = 1 as const;
export const SCM_HANDOFF_TTL_MS = 8 * 60 * 60 * 1_000;
const STORAGE_PREFIX = `houzs:scm-handoff:v${SCM_HANDOFF_VERSION}:`;

type ScmHandoffEnvelope<T> = {
  v: typeof SCM_HANDOFF_VERSION;
  user: number;
  company: number;
  createdAt: number;
  payload: T;
};

function storageKey(key: ScmHandoffKey): string {
  return `${STORAGE_PREFIX}${key}`;
}

function removePhysicalKey(key: ScmHandoffKey): void {
  try {
    sessionStorage.removeItem(storageKey(key));
  } catch {
    // Storage may be disabled. Reads and removals remain fail-closed.
  }
}

/**
 * Store a short-lived SCM navigation handoff for the currently bound user and
 * company. Returns false when there is no authenticated storage identity or
 * when the browser refuses the write.
 */
export function writeScmHandoff<T>(key: ScmHandoffKey, payload: T): boolean {
  const identity = getBrowserStorageIdentity();
  if (!identity) return false;

  const envelope: ScmHandoffEnvelope<T> = {
    v: SCM_HANDOFF_VERSION,
    user: identity.userId,
    company: identity.companyId,
    createdAt: Date.now(),
    payload,
  };

  try {
    sessionStorage.setItem(storageKey(key), JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read only a current, unexpired handoff for the bound user and company.
 * Corrupt, expired, future-dated, or wrong-scope envelopes are discarded.
 * Historical bare sessionStorage keys are deliberately ignored.
 */
export function readScmHandoff<T>(key: ScmHandoffKey): T | null {
  const identity = getBrowserStorageIdentity();
  if (!identity) return null;

  let parsed: unknown;
  try {
    const raw = sessionStorage.getItem(storageKey(key));
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    removePhysicalKey(key);
    return null;
  }

  const envelope = parsed as Partial<ScmHandoffEnvelope<T>> | null;
  const createdAt = envelope?.createdAt;
  const now = Date.now();
  const valid =
    envelope !== null &&
    typeof envelope === "object" &&
    envelope.v === SCM_HANDOFF_VERSION &&
    envelope.user === identity.userId &&
    envelope.company === identity.companyId &&
    typeof createdAt === "number" &&
    Number.isFinite(createdAt) &&
    createdAt <= now &&
    now - createdAt <= SCM_HANDOFF_TTL_MS &&
    Object.prototype.hasOwnProperty.call(envelope, "payload");

  if (!valid) {
    removePhysicalKey(key);
    return null;
  }

  return envelope.payload as T;
}

export function removeScmHandoff(key: ScmHandoffKey): void {
  removePhysicalKey(key);
}

/** Remove every scoped handoff and known historical bare key on identity/tenant exit. */
export function clearAllScmHandoffs(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
    for (const key of SCM_HANDOFF_KEYS) sessionStorage.removeItem(key);
  } catch {
    // Best effort for privacy cleanup when browser storage is unavailable.
  }
}
