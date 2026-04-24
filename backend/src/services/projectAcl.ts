import type { AuthUser } from "./auth";

/**
 * Build the allow-list of PIC ids for the current user, or null if the
 * user's role isn't scoped (admins/ops/finance see everything).
 *
 * One-hop rule: a scoped user sees projects where pic_id is themselves
 * or their direct manager. That matches the sales-team model — a rep
 * only sees projects their PIC (their manager) is running.
 *
 * Return shape:
 *   null              → no ACL; caller runs an unfiltered query
 *   [ids]             → filter projects to pic_id IN (...)
 *   []                → scoped user with nothing in their line (e.g.
 *                       no manager set). Caller should short-circuit
 *                       to an empty list rather than run the query.
 */
export function getProjectPicScope(user: AuthUser): number[] | null {
  if (!user.scope_to_pic) return null;
  const ids: number[] = [];
  if (user.id) ids.push(user.id);
  if (user.manager_id) ids.push(user.manager_id);
  return ids;
}

/**
 * Per-project access tier for rendering decisions. "full" = PIC or
 * unscoped role — can see finances, logistics, POs. "limited" =
 * scoped user viewing a project where they aren't the PIC.
 */
export function projectAccessLevel(
  user: AuthUser,
  project: { pic_id: number | null }
): "full" | "limited" {
  if (!user.scope_to_pic) return "full";
  if (project.pic_id === user.id) return "full";
  return "limited";
}

/**
 * Hard gate: can this user see this project at all? Returns false only
 * for scoped users viewing a project outside their PIC line.
 */
export function canSeeProject(
  user: AuthUser,
  project: { pic_id: number | null }
): boolean {
  if (!user.scope_to_pic) return true;
  if (project.pic_id == null) return false;
  if (project.pic_id === user.id) return true;
  if (user.manager_id && project.pic_id === user.manager_id) return true;
  return false;
}
