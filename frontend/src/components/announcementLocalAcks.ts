const MAX_ACKS = 200;
const CLOCK_SKEW_MS = 5 * 60_000;

export type AnnouncementAcks = Record<string, number>;

export function sanitizeAnnouncementAcks(value: unknown, now = Date.now()): AnnouncementAcks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([id, timestamp]) =>
        id.length > 0 &&
        typeof timestamp === "number" &&
        Number.isFinite(timestamp) &&
        timestamp > 0 &&
        timestamp <= now + CLOCK_SKEW_MS,
      )
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, MAX_ACKS),
  ) as AnnouncementAcks;
}

export function readAnnouncementAcks(storageKey: string | null): AnnouncementAcks {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? sanitizeAnnouncementAcks(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function mergeAndWriteAnnouncementAcks(
  storageKey: string | null,
  next: AnnouncementAcks,
): AnnouncementAcks {
  const merged = sanitizeAnnouncementAcks({
    ...readAnnouncementAcks(storageKey),
    ...next,
  });
  if (!storageKey) return merged;
  try {
    localStorage.setItem(storageKey, JSON.stringify(merged));
  } catch {
    // Persistence is best-effort; keep the in-memory result.
  }
  return merged;
}
