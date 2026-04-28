import type { AuthUser } from "./auth";

export interface ProjectScope {
  /** PIC allow-list as today: [user.id, user.manager_id] (nulls dropped). */
  pic_ids: number[];
  /**
   * Brand allow-list from the user's department (department_brands).
   * Empty array means the scoped user belongs to a department with no
   * brands assigned (or no department at all) — they should see no
   * projects.
   */
  brands: string[];
}

/**
 * Combined scope for the current user, or null when the role isn't
 * scope_to_pic (admins / ops / finance run unfiltered queries).
 *
 * One-hop PIC rule: scoped user sees projects where pic_id is them or
 * their manager. Brand rule (added 048): the project's brand must be
 * in the user's department's brand allow-list.
 */
export function getProjectScope(user: AuthUser): ProjectScope | null {
  if (!user.scope_to_pic) return null;
  const pic_ids: number[] = [];
  if (user.id) pic_ids.push(user.id);
  if (user.manager_id) pic_ids.push(user.manager_id);
  const brands = user.brand_scope ?? [];
  return { pic_ids, brands };
}

/**
 * Back-compat shim. Kept so any caller that only cares about the PIC
 * dimension keeps working. Prefer `getProjectScope` for new code so the
 * brand filter is wired automatically.
 */
export function getProjectPicScope(user: AuthUser): number[] | null {
  const s = getProjectScope(user);
  return s ? s.pic_ids : null;
}

/** Effective PIC id — falls back to the creator when pic_id is unset.
 *  Keeps legacy projects (created before migration 039) visible to
 *  their creator's team, without requiring a full backfill. */
function effectivePicId(project: { pic_id: number | null; created_by?: number | null }): number | null {
  if (project.pic_id != null) return project.pic_id;
  return project.created_by ?? null;
}

/**
 * Per-project access tier for rendering decisions. "full" = PIC or
 * unscoped role — can see finances, logistics, POs. "limited" =
 * scoped user viewing a project where they aren't the PIC.
 */
export function projectAccessLevel(
  user: AuthUser,
  project: { pic_id: number | null; created_by?: number | null }
): "full" | "limited" {
  if (!user.scope_to_pic) return "full";
  if (effectivePicId(project) === user.id) return "full";
  return "limited";
}

/**
 * Hard gate: can this user see this project at all? Returns false for
 * scoped users viewing a project outside their PIC line OR outside
 * their department's brand list.
 */
export function canSeeProject(
  user: AuthUser,
  project: {
    pic_id: number | null;
    created_by?: number | null;
    brand?: string | null;
  }
): boolean {
  if (!user.scope_to_pic) return true;
  const pic = effectivePicId(project);
  if (pic == null) return false;
  const inPicLine = pic === user.id || (user.manager_id != null && pic === user.manager_id);
  if (!inPicLine) return false;
  // Brand gate. A scoped user with an empty brand list sees nothing
  // (forces admins to configure dept brands explicitly). Projects with
  // no brand are likewise invisible to scoped users — set the brand to
  // make them appear.
  const brands = user.brand_scope ?? [];
  if (brands.length === 0) return false;
  if (!project.brand) return false;
  return brands.includes(project.brand);
}
