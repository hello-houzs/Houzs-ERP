import { Wrench, Construction } from "lucide-react";

export default function OperationPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[#0A1F2E]">Operation</h1>
        <p className="text-sm text-gray-500 mt-1 inline-flex items-center gap-1.5">
          <Wrench className="h-3.5 w-3.5" />
          Setup, dismantle, contractors, permits &amp; on-site execution
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-[#DDE5E5] bg-white p-10 text-center">
        <div className="h-12 w-12 rounded-full bg-[#0F766E]/10 inline-flex items-center justify-center mb-3">
          <Construction className="h-6 w-6 text-[#0F766E]" />
        </div>
        <div className="text-[14px] font-semibold text-[#0A1F2E]">Operation module coming soon</div>
        <div className="text-[11px] text-gray-500 mt-1 max-w-md mx-auto">
          Contractor assignments, setup / dismantle schedule, loading bay permits,
          on-site issue log. For now, per-event setup &amp; dismantle details live on the
          event detail page.
        </div>
      </div>
    </div>
  );
}
