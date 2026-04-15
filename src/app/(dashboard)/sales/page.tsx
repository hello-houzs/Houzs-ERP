"use client";

import { Users, Construction } from "lucide-react";

export default function SalesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[#0A1F2E]">Sales</h1>
        <p className="text-sm text-gray-500 mt-1 inline-flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Sales pipeline, leads, quotations &amp; commission tracking
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-[#DDE5E5] bg-white p-10 text-center">
        <div className="h-12 w-12 rounded-full bg-[#0F766E]/10 inline-flex items-center justify-center mb-3">
          <Construction className="h-6 w-6 text-[#0F766E]" />
        </div>
        <div className="text-[14px] font-semibold text-[#0A1F2E]">Sales module coming soon</div>
        <div className="text-[11px] text-gray-500 mt-1 max-w-md mx-auto">
          Sales pipeline, lead management, quotation workflow and commission reports will
          live here. For now, per-event sales totals are on the Project Financial Report.
        </div>
      </div>
    </div>
  );
}
