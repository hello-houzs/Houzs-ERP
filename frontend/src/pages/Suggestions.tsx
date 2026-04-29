import { MessageCircle } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { IdeaList } from "../components/IdeaList";

const STATUSES = [
  { value: "review", label: "Under review" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
] as const;

export function Suggestions() {
  return (
    <div>
      <PageHeader
        eyebrow="Engagement"
        title="Suggestion box"
        description="Quick fixes, papercuts, things that annoy you. Approved suggestions earn the submitter Houzs Points."
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
      />
    </div>
  );
}
