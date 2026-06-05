import { Link } from "react-router-dom";
import { FolderKanban, MapPin, ChevronRight, Wrench, Hammer } from "lucide-react";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { formatDate, cn } from "../lib/utils";

interface DriverProjectListItem {
  id: number;
  code: string | null;
  name: string;
  brand: string | null;
  venue: string | null;
  venue_address: string | null;
  state: string | null;
  start_date: string | null;
  end_date: string | null;
  setup_start_at: string | null;
  setup_end_at: string | null;
  dismantle_start_at: string | null;
  dismantle_end_at: string | null;
  my_phases: Array<"setup" | "dismantle">;
}

/**
 * Driver-app "My Projects" list. Shows projects where the caller is on
 * any setup/dismantle crew slot. Read-only listing; tap to open the
 * brief + photo upload screen.
 */
export function DriverProjects() {
  const list = useQuery<{ data: DriverProjectListItem[] }>(
    () => api.get("/api/driver/projects")
  );

  return (
    <div className="px-4 py-5">
      <div className="mb-5">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
          Crew
        </div>
        <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
          My Projects
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Projects you're crewed on for setup or dismantle.
        </p>
      </div>

      {list.loading && <div className="text-sm text-ink-secondary">Loading…</div>}
      {list.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-sm text-err">
          {list.error}
        </div>
      )}

      {list.data && list.data.data.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center">
          <FolderKanban size={28} className="mx-auto mb-3 text-ink-secondary" />
          <div className="text-sm font-semibold text-ink">No projects assigned</div>
          <div className="mt-1 text-xs text-ink-secondary">
            New projects appear here once ops adds you to a setup or dismantle crew.
          </div>
        </div>
      )}

      <div className="space-y-3">
        {list.data?.data.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({ project }: { project: DriverProjectListItem }) {
  const hasSetup = project.my_phases.includes("setup");
  const hasDismantle = project.my_phases.includes("dismantle");
  return (
    <Link
      to={`/driver/projects/${project.id}`}
      className="block rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors active:bg-paper"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {project.brand && (
              <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink">
                {project.brand}
              </span>
            )}
            {hasSetup && (
              <PhaseChip phase="setup" />
            )}
            {hasDismantle && (
              <PhaseChip phase="dismantle" />
            )}
          </div>
          <div className="mt-1.5 truncate font-display text-[15px] font-bold text-ink">
            {project.name}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-secondary">
            <MapPin size={13} />
            <span className="truncate">{project.venue || "Venue TBD"}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-muted">
            {formatDate(project.start_date)} – {formatDate(project.end_date)}
          </div>
        </div>
        <ChevronRight size={18} className="mt-1 shrink-0 text-ink-muted" />
      </div>
    </Link>
  );
}

function PhaseChip({ phase }: { phase: "setup" | "dismantle" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        phase === "setup"
          ? "bg-accent/10 text-accent"
          : "bg-warning-bg text-warning-text"
      )}
    >
      {phase === "setup" ? <Wrench size={10} /> : <Hammer size={10} />}
      {phase}
    </span>
  );
}
