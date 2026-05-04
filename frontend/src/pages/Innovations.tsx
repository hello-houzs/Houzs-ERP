import { useRef, useState } from "react";
import { Lightbulb, Plus } from "lucide-react";
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
  const triggerRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);

  return (
    <div>
      <PageHeader
        eyebrow="Engagement"
        title="Innovation box"
        description="Strategic ideas — new features, ways of working, products to explore. Posts that ship earn the submitter Houzs Points."
        actions={
          <button
            type="button"
            disabled={!ready}
            onClick={() => triggerRef.current?.()}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-all hover:bg-accent/90 active:scale-95 disabled:opacity-50"
          >
            <Plus size={14} /> Post innovation
          </button>
        }
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
        extraFields={[
          {
            key: "tags",
            label: "Tags (comma-separated)",
            placeholder: "e.g. logistics, mobile, hr",
            maxLength: 200,
          },
        ]}
        registerPostTrigger={(fn) => {
          triggerRef.current = fn;
          setReady(true);
        }}
      />
    </div>
  );
}
