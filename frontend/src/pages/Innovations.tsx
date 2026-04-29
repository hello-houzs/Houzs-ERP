import { Lightbulb } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { IdeaList } from "../components/IdeaList";

const STATUSES = [
  { value: "review", label: "Under review" },
  { value: "accepted", label: "Accepted" },
  { value: "in_progress", label: "In progress" },
  { value: "shipped", label: "Shipped" },
  { value: "declined", label: "Declined" },
] as const;

export function Innovations() {
  return (
    <div>
      <PageHeader
        eyebrow="Engagement"
        title="Innovation box"
        description="Strategic ideas — new features, ways of working, products to explore. Posts that ship earn the submitter Houzs Points."
      />

      <div className="mb-4 flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-2 text-[11.5px] text-ink-secondary">
        <Lightbulb size={13} className="text-accent" />
        <span>
          Five-stage pipeline: <strong className="text-ink">review → accepted → in progress → shipped</strong>. Hitting <em>shipped</em> credits the submitter automatically.
        </span>
      </div>

      <IdeaList
        target="innovation"
        statuses={[...STATUSES]}
        rewardLabel="Reward when shipped"
        bodyRequired
        formIntro="The big stuff. New tools, new processes, new product directions. Tag liberally so search can find your post later."
        renderExtraFields={(state, set) => (
          <label className="block">
            <span className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
              Tags (comma-separated)
            </span>
            <input
              value={state.tags || ""}
              onChange={(e) => set("tags", e.target.value.slice(0, 200))}
              placeholder="e.g. logistics, mobile, hr"
              className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
            />
          </label>
        )}
      />
    </div>
  );
}
