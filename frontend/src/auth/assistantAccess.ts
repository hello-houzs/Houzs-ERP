// ---------------------------------------------------------------------------
// assistantAccess.ts — FE mirror of the backend Assistant deny list.
//
// LOCKSTEP FIXTURE, not a second source. Under the vendored-clone architecture the
// FE and BE share no import, so the only thing keeping them honest is that both
// name the same three positions and both have a test saying so. The BACKEND is the
// control (routes/assistant.ts returns 403); this file exists so a Driver is not
// shown a menu item that will 403 when tapped.
//
// Exact normalised match, never a substring: `Storekeeper` would swallow
// "Storekeeper Supervisor", and a word-boundary regex over a free-text position
// name is how a RENAME silently moves permissions (BUG-HISTORY 2026-07-18).
// ---------------------------------------------------------------------------

export const ASSISTANT_DENIED_POSITIONS: ReadonlySet<string> = new Set([
  "driver",
  "helper",
  "storekeeper",
]);

const normalise = (n: string | null | undefined): string =>
  String(n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function canUseAssistant(
  user: { permissions?: unknown; position_name?: string | null } | null | undefined,
): boolean {
  const perms = user?.permissions;
  const isWildcard = Array.isArray(perms)
    ? perms.includes("*")
    : typeof perms === "string" && perms.trim() === "*";
  if (isWildcard) return true;
  return !ASSISTANT_DENIED_POSITIONS.has(normalise(user?.position_name));
}
