// ---------------------------------------------------------------------------
// Mail Center — shared mutation helpers for thread actions.
//
// These wrap the backend thread-mutation endpoint:
//   PATCH /api/mail-center/threads/:id
// which accepts status (open/closed), assignedTo*, and the email-client
// affordances starred / labels / unread / trashed (all DB-backed). The list
// rows, bulk action bar and reading pane all post the same way.
//
// Houzs cache invalidation: the shared api client (api/client.ts) invalidates
// the WHOLE resource family on every mutation — invalidateForMutation matches
// the first path segment, so any PATCH/POST/DELETE under `/api/mail-center/*`
// clears every cached `/api/mail-center*` GET (threads list, single thread,
// addresses, labels) in this tab and, via BroadcastChannel, every other tab.
// So we don't hand-invalidate per-prefix the way Hookka did — the client does
// it for us. Only compose DRAFTS remain local (mail-local.ts).
// ---------------------------------------------------------------------------
import { api } from "../../api/client";

// Generic single-thread PATCH used by the star / label / unread / trash helpers
// below. Posts an arbitrary subset of the mutable fields. Returns true on success.
type ThreadPatch = {
  status?: "open" | "closed";
  assignedToUserId?: string | number | null;
  assignedToName?: string | null;
  starred?: boolean;
  labels?: string[];
  unread?: boolean;
  trashed?: boolean;
};

async function patchThread(id: string, patch: ThreadPatch): Promise<boolean> {
  try {
    await api.patch(`/api/mail-center/threads/${id}`, patch);
    return true;
  } catch {
    return false;
  }
}

// Star / unstar a single thread (DB-backed). Returns true on success.
export async function patchThreadStarred(
  id: string,
  starred: boolean,
): Promise<boolean> {
  return patchThread(id, { starred });
}

// Replace a thread's label set (DB-backed JSON array). Returns true on success.
export async function patchThreadLabels(
  id: string,
  labels: string[],
): Promise<boolean> {
  return patchThread(id, { labels });
}

// Mark a thread read (unread=false) / unread (unread=true). This is the only
// path that can SET unread back on — GET /threads/:id clears it on open.
export async function patchThreadUnread(
  id: string,
  unread: boolean,
): Promise<boolean> {
  return patchThread(id, { unread });
}

// Move a thread to Trash (trashed=true) / restore it (trashed=false), DB-backed
// soft delete. Returns true on success.
export async function patchThreadTrashed(
  id: string,
  trashed: boolean,
): Promise<boolean> {
  return patchThread(id, { trashed });
}

// Bulk variants — sequential (Hyperdrive throttles bursts; these lists are a
// handful of selected rows). Each resolves with the count that succeeded so
// callers can report partial failures honestly.
export async function patchManyUnread(
  ids: string[],
  unread: boolean,
): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadUnread(id, unread)) ok++;
  }
  return ok;
}

export async function patchManyTrashed(
  ids: string[],
  trashed: boolean,
): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadTrashed(id, trashed)) ok++;
  }
  return ok;
}

// PATCH a single thread's status (open = Inbox, closed = Done/Archive).
export async function patchThreadStatus(
  id: string,
  status: "open" | "closed",
): Promise<boolean> {
  return patchThread(id, { status });
}

// Set status on many threads (bulk archive / move-to-inbox). Resolves with the
// count that succeeded. Sequential on purpose (Hyperdrive throttles bursts).
export async function patchManyStatus(
  ids: string[],
  status: "open" | "closed",
): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadStatus(id, status)) ok++;
  }
  return ok;
}

// Assign / unassign a single thread.
export async function patchThreadAssignment(
  id: string,
  assignedToUserId: string | number | null,
  assignedToName: string | null,
): Promise<boolean> {
  return patchThread(id, { assignedToUserId, assignedToName });
}

// Apply ONE label name to many threads (bulk label). Merges the name into each
// thread's existing set (case-insensitive, no duplicates). Resolves with the
// count that succeeded. `items` maps threadId → its existing label names.
export async function patchManyAddLabel(
  items: { id: string; labels: string[] }[],
  name: string,
): Promise<number> {
  const clean = name.trim();
  if (!clean) return 0;
  let ok = 0;
  for (const it of items) {
    const has = it.labels.some((l) => l.toLowerCase() === clean.toLowerCase());
    const next = has ? it.labels : [...it.labels, clean];
    if (await patchThreadLabels(it.id, next)) ok++;
  }
  return ok;
}

// ── Label catalogue (name → colour) ────────────────────────────────────────
// The per-thread label SET still lives on email_threads.labels; this catalogue
// only carries colours + the canonical managed list. A rename cascades
// server-side into the thread label arrays; the shared client invalidation
// refreshes the list rows so the new name shows.

export async function createLabel(
  name: string,
  color: string,
): Promise<boolean> {
  const clean = name.trim();
  if (!clean) return false;
  try {
    await api.post("/api/mail-center/labels", { name: clean, color });
    return true;
  } catch {
    return false;
  }
}

export async function updateLabel(
  id: string,
  patch: { name?: string; color?: string },
): Promise<boolean> {
  try {
    await api.patch(`/api/mail-center/labels/${id}`, patch);
    return true;
  } catch {
    return false;
  }
}

export async function deleteLabel(id: string): Promise<boolean> {
  try {
    await api.del(`/api/mail-center/labels/${id}`);
    return true;
  } catch {
    return false;
  }
}

// ── Department / shared mailbox provisioning ───────────────────────────────
// Admin one-click setup for a SHARED department mailbox (support@/finance@/hr@):
// reuses POST /api/mail-center/addresses (the same endpoint User Management
// uses), creating an address row with an assignedDept and NO assigned user.
// Returns the new address id on success, or null on failure / 403 (non-admin).
export async function createDeptMailbox(
  address: string,
  dept: string,
  label: string,
): Promise<string | null> {
  try {
    const body = await api.post<{ id?: string }>("/api/mail-center/addresses", {
      address,
      assignedDept: dept,
      label,
    });
    return body?.id ?? "";
  } catch {
    return null;
  }
}
