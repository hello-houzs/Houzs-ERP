"use client";

import Link from "next/link";
import { Briefcase, ArrowRight } from "lucide-react";

export default function PmDepartmentPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[#0A1F2E]">PM Department</h1>
        <p className="text-sm text-gray-500 mt-1 inline-flex items-center gap-1.5">
          <Briefcase className="h-3.5 w-3.5" />
          Project Management workspace — workflow, approvals, organizer/venue tracker
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Link
          href="/"
          className="rounded-lg border border-[#DDE5E5] bg-white p-4 hover:border-[#0F766E] hover:shadow-sm transition group"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Dashboard</div>
          <div className="text-[14px] font-bold text-[#0A1F2E] mt-1">Project Management Dashboard</div>
          <div className="text-[11px] text-gray-500 mt-1">11 PM workflow checkpoints across all events</div>
          <div className="mt-3 text-[11px] font-semibold text-[#0F766E] inline-flex items-center gap-1 group-hover:gap-2 transition-all">
            Open <ArrowRight className="h-3 w-3" />
          </div>
        </Link>
        <Link
          href="/pms"
          className="rounded-lg border border-[#DDE5E5] bg-white p-4 hover:border-[#0F766E] hover:shadow-sm transition group"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Projects</div>
          <div className="text-[14px] font-bold text-[#0A1F2E] mt-1">Project Details</div>
          <div className="text-[11px] text-gray-500 mt-1">Card view of every event with status &amp; progress</div>
          <div className="mt-3 text-[11px] font-semibold text-[#0F766E] inline-flex items-center gap-1 group-hover:gap-2 transition-all">
            Open <ArrowRight className="h-3 w-3" />
          </div>
        </Link>
        <Link
          href="/calendar"
          className="rounded-lg border border-[#DDE5E5] bg-white p-4 hover:border-[#0F766E] hover:shadow-sm transition group"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Schedule</div>
          <div className="text-[14px] font-bold text-[#0A1F2E] mt-1">Calendar</div>
          <div className="text-[11px] text-gray-500 mt-1">Monthly view of event bookings</div>
          <div className="mt-3 text-[11px] font-semibold text-[#0F766E] inline-flex items-center gap-1 group-hover:gap-2 transition-all">
            Open <ArrowRight className="h-3 w-3" />
          </div>
        </Link>
        <Link
          href="/finance"
          className="rounded-lg border border-[#DDE5E5] bg-white p-4 hover:border-[#0F766E] hover:shadow-sm transition group"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Financials</div>
          <div className="text-[14px] font-bold text-[#0A1F2E] mt-1">Project Financial Report</div>
          <div className="text-[11px] text-gray-500 mt-1">Sales, COGS, net profit per event</div>
          <div className="mt-3 text-[11px] font-semibold text-[#0F766E] inline-flex items-center gap-1 group-hover:gap-2 transition-all">
            Open <ArrowRight className="h-3 w-3" />
          </div>
        </Link>
        <Link
          href="/settings"
          className="rounded-lg border border-[#DDE5E5] bg-white p-4 hover:border-[#0F766E] hover:shadow-sm transition group"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Master Data</div>
          <div className="text-[14px] font-bold text-[#0A1F2E] mt-1">Organizers, Venues, PICs, Contractors</div>
          <div className="text-[11px] text-gray-500 mt-1">Manage dropdown options</div>
          <div className="mt-3 text-[11px] font-semibold text-[#0F766E] inline-flex items-center gap-1 group-hover:gap-2 transition-all">
            Open <ArrowRight className="h-3 w-3" />
          </div>
        </Link>
      </div>

      <div className="rounded-md border border-dashed border-[#DDE5E5] bg-[#F4F7F7] px-4 py-3 text-[11px] text-gray-500">
        <span className="font-semibold text-[#0A1F2E]">Note:</span> This page is the PM
        department landing — deeper tools (Organizer Venue Tracker, agreement repository,
        designer handoff board) will be added here.
      </div>
    </div>
  );
}
