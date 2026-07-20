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
  "siPaymentRetry",
  "soScanPrefill",
  "soPaymentRetry",
] as const;

export type ScmHandoffKey = (typeof SCM_HANDOFF_KEYS)[number];

export const SCM_HANDOFF_VERSION = 1 as const;
export const SCM_HANDOFF_TTL_MS = 8 * 60 * 60 * 1_000;
/** Must stay below the backend's 24-hour idempotency retention. */
export const SCM_PAYMENT_RETRY_TTL_MS = 23 * 60 * 60 * 1_000;
const STORAGE_PREFIX = `houzs:scm-handoff:v${SCM_HANDOFF_VERSION}:`;
const DURABLE_KEYS = new Set<ScmHandoffKey>(["siPaymentRetry", "soPaymentRetry"]);

type ScmHandoffEnvelope<T> = {
  v: typeof SCM_HANDOFF_VERSION;
  user: number;
  company: number;
  createdAt: number;
  payload: T;
};

function storageKey(
  key: ScmHandoffKey,
  identity: ReturnType<typeof getBrowserStorageIdentity>,
  instanceId?: string,
): string | null {
  if (!DURABLE_KEYS.has(key)) return `${STORAGE_PREFIX}${key}`;
  if (!identity || !instanceId) return null;
  return `${STORAGE_PREFIX}${key}:u${identity.userId}:c${identity.companyId}:${encodeURIComponent(instanceId)}`;
}

function durableStoragePrefix(
  key: ScmHandoffKey,
  identity: NonNullable<ReturnType<typeof getBrowserStorageIdentity>>,
): string {
  return `${STORAGE_PREFIX}${key}:u${identity.userId}:c${identity.companyId}:`;
}

function storageFor(key: ScmHandoffKey): Storage {
  return DURABLE_KEYS.has(key) ? localStorage : sessionStorage;
}

function ttlFor(key: ScmHandoffKey): number {
  return DURABLE_KEYS.has(key) ? SCM_PAYMENT_RETRY_TTL_MS : SCM_HANDOFF_TTL_MS;
}

function removePhysicalKey(key: ScmHandoffKey, instanceId?: string): boolean {
  const physicalKey = storageKey(key, getBrowserStorageIdentity(), instanceId);
  if (!physicalKey) return false;
  try {
    storageFor(key).removeItem(physicalKey);
    // Remove a copy left by an older build if this key's durability policy
    // changed. The other store never wins reads.
    (DURABLE_KEYS.has(key) ? sessionStorage : localStorage).removeItem(physicalKey);
    return true;
  } catch {
    // Storage may be disabled. Reads and removals remain fail-closed.
    return false;
  }
}

/**
 * Store a short-lived SCM navigation handoff for the currently bound user and
 * company. Returns false when there is no authenticated storage identity or
 * when the browser refuses the write.
 */
export function writeScmHandoff<T>(key: ScmHandoffKey, payload: T, instanceId?: string): boolean {
  const identity = getBrowserStorageIdentity();
  if (!identity) return false;
  const physicalKey = storageKey(key, identity, instanceId);
  if (!physicalKey) return false;

  const envelope: ScmHandoffEnvelope<T> = {
    v: SCM_HANDOFF_VERSION,
    user: identity.userId,
    company: identity.companyId,
    createdAt: Date.now(),
    payload,
  };

  try {
    storageFor(key).setItem(physicalKey, JSON.stringify(envelope));
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
export function readScmHandoff<T>(key: ScmHandoffKey, instanceId?: string): T | null {
  const identity = getBrowserStorageIdentity();
  if (!identity) return null;
  const physicalKey = storageKey(key, identity, instanceId);
  if (!physicalKey) return null;

  let parsed: unknown;
  try {
    const raw = storageFor(key).getItem(physicalKey);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    removePhysicalKey(key, instanceId);
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
    now - createdAt <= ttlFor(key) &&
    Object.prototype.hasOwnProperty.call(envelope, "payload");

  if (!valid) {
    removePhysicalKey(key, instanceId);
    return null;
  }

  return envelope.payload as T;
}

export function removeScmHandoff(key: ScmHandoffKey, instanceId?: string): boolean {
  return removePhysicalKey(key, instanceId);
}

export function listScmHandoffInstances<T>(
  key: ScmHandoffKey,
  instancePrefix: string,
): Array<{ instanceId: string; payload: T }> {
  const identity = getBrowserStorageIdentity();
  if (!identity || !DURABLE_KEYS.has(key)) return [];
  const physicalPrefix = durableStoragePrefix(key, identity);
  const matches: Array<{ instanceId: string; payload: T }> = [];
  try {
    const instanceIds: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const physicalKey = localStorage.key(index);
      if (!physicalKey?.startsWith(physicalPrefix)) continue;
      let instanceId: string;
      try {
        instanceId = decodeURIComponent(physicalKey.slice(physicalPrefix.length));
      } catch {
        continue;
      }
      if (instanceId.startsWith(instancePrefix)) instanceIds.push(instanceId);
    }
    for (const instanceId of instanceIds) {
      const payload = readScmHandoff<T>(key, instanceId);
      if (payload !== null) matches.push({ instanceId, payload });
    }
  } catch {
    return [];
  }
  return matches;
}

/** Remove every scoped handoff and known historical bare key on identity/tenant exit. */
export function clearAllScmHandoffs(): void {
  const identity = getBrowserStorageIdentity();
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key && /^houzs:scm-handoff:v\d+:/.test(key)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
    for (const key of SCM_HANDOFF_KEYS) sessionStorage.removeItem(key);
  } catch {
    // Best effort for privacy cleanup when browser storage is unavailable.
  }
  if (!identity) return;
  try {
    const scope = `:u${identity.userId}:c${identity.companyId}:`;
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && /^houzs:scm-handoff:v\d+:(?:so|si)PaymentRetry:/.test(key) && key.includes(scope)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Never clear another signed-in tab's durable retry intents.
  }
}
