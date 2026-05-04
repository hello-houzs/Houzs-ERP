import { useRef, useState } from "react";
import { MessageCircle, Plus } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { IdeaList } from "../components/IdeaList";

const STATUSES = [
  { value: "review", label: "Under review" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
] as const;

export function Suggestions() {
  const triggerRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);

  return (
    <div>
      <PageHeader
        eyebrow="Engagement"
        title="Suggestion box"
        description="Quick fixes, papercuts, things that annoy you. Approved suggestions earn the submitter Houzs Points."
        actions={
          <button
            type="button"
            disabled={!ready}
            onClick={() => triggerRef.current?.()}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-all hover:bg-accent/90 active:scale-95 disabled:opacity-50"
          >
            <Plus size={14} /> Post suggestion
          </button>
        }
      />

      <div className="mb-4 flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-2 text-[11.5px] text-ink-secondary">
        <MessageCircle size={13} className="text-accent" />
        <span>
          Three-stage pipeline: <strong className="text-ink">review → approved</strong> (or declined with a reason). Approval credits the submitter automatically.
        </span>
      </div>

      <IdeaList
        target="suggestion"
        statuses={[...STATUSES]}
        rewardLabel="Reward when approved"
        formIntro="Operational fixes. One-line is fine — if a sentence captures it, send it."
        registerPostTrigger={(fn) => {
          triggerRef.current = fn;
          setReady(true);
        }}
      />
    </div>
  );
}
