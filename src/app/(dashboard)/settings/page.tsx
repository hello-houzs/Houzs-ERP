"use client";

import { useState, type ReactNode } from "react";
import { Plus, Trash2, Database, AlertTriangle } from "lucide-react";
import { STATES, type MalaysianState } from "@/lib/mock-data";
import {
  useMasterData,
  addOrganizer,
  removeOrganizer,
  addVenue,
  removeVenue,
  addPic,
  removePic,
  addContractor,
  removeContractor,
  addDriver,
  removeDriver,
  addLori,
  removeLori,
  resetMasterData,
} from "@/lib/master-data-store";

const inputClass =
  "h-9 rounded-md border border-[#DDE5E5] px-2.5 text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]";
const selectClass = inputClass + " appearance-none cursor-pointer";

function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
        <div>
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">
            {title}
          </h2>
          <p className="text-[10px] text-gray-500 mt-0.5">{subtitle}</p>
        </div>
        <span className="text-[10px] font-semibold text-[#0F766E] bg-[#0F766E]/10 rounded px-2 py-0.5">
          {count} item{count === 1 ? "" : "s"}
        </span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function SimpleList({
  items,
  onAdd,
  onRemove,
  placeholder,
}: {
  items: string[];
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  function submit() {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder={placeholder}
          className={`${inputClass} flex-1`}
        />
        <button
          type="button"
          onClick={submit}
          className="h-9 px-3 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-[#DDE5E5] p-4 text-center text-[11px] text-gray-400">
          No items yet
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 rounded-md border border-[#DDE5E5] bg-[#F4F7F7] pl-2.5 pr-1 py-1 text-[11px] text-[#0A1F2E]"
            >
              {item}
              <button
                type="button"
                onClick={() => onRemove(item)}
                className="h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50"
                title="Remove"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DriverList() {
  const master = useMasterData();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  function submit() {
    const n = name.trim();
    if (!n) return;
    addDriver(n, phone);
    setName("");
    setPhone("");
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="Driver name (e.g. YUNUS)"
          className={`${inputClass} flex-1`}
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="013-580 0830"
          className={`${inputClass} w-36`}
        />
        <button
          type="button"
          onClick={submit}
          className="h-9 px-3 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      {master.drivers.length === 0 ? (
        <div className="rounded-md border border-dashed border-[#DDE5E5] p-4 text-center text-[11px] text-gray-400">
          No drivers yet
        </div>
      ) : (
        <div className="divide-y divide-[#F0F3F3] border border-[#DDE5E5] rounded-md max-h-64 overflow-y-auto">
          {master.drivers.map((d) => (
            <div key={d.name} className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-[#F4F7F7]">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold text-[#0A1F2E] truncate">{d.name}</div>
                <div className="text-[9px] text-gray-500 tabular-nums">{d.phone || "—"}</div>
              </div>
              <button
                type="button"
                onClick={() => removeDriver(d.name)}
                className="h-7 w-7 rounded inline-flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 shrink-0"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const master = useMasterData();
  const [venueDraft, setVenueDraft] = useState("");
  const [venueState, setVenueState] = useState<MalaysianState>("KL");
  const [filterState, setFilterState] = useState<MalaysianState | "ALL">("ALL");
  const [confirmReset, setConfirmReset] = useState(false);

  function addVenueSubmit() {
    const v = venueDraft.trim();
    if (!v) return;
    addVenue(v, venueState);
    setVenueDraft("");
  }

  const filteredVenues =
    filterState === "ALL"
      ? master.venues
      : master.venues.filter((v) => v.state === filterState);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E]">Master Data</h1>
          <p className="text-sm text-gray-500 mt-1 inline-flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5" />
            Manage dropdown options for organizers, venues, PICs, contractors
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          className="h-9 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-red-300 hover:text-red-600 inline-flex items-center gap-1.5"
        >
          <AlertTriangle className="h-3.5 w-3.5" /> Reset to seed
        </button>
      </div>

      {confirmReset && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 flex items-center justify-between gap-3">
          <div className="text-[11px] text-red-700">
            This will wipe all custom entries and re-seed from mockEvents. Are you sure?
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              className="h-7 px-2.5 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-gray-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { resetMasterData(); setConfirmReset(false); }}
              className="h-7 px-2.5 rounded bg-red-600 text-white text-[10px] font-semibold hover:bg-red-700"
            >
              Yes, reset
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section
          title="Organizers"
          subtitle="Event organizer companies (e.g. MEGAHOME, KAI HAO)"
          count={master.organizers.length}
        >
          <SimpleList
            items={master.organizers}
            onAdd={addOrganizer}
            onRemove={removeOrganizer}
            placeholder="e.g. MEGAHOME"
          />
        </Section>

        <Section
          title="PICs"
          subtitle="Person in charge (PM managers)"
          count={master.pics.length}
        >
          <SimpleList
            items={master.pics}
            onAdd={addPic}
            onRemove={removePic}
            placeholder="e.g. PETER"
          />
        </Section>

        <Section
          title="Contractors"
          subtitle="Setup / build contractors"
          count={master.contractors.length}
        >
          <SimpleList
            items={master.contractors}
            onAdd={addContractor}
            onRemove={removeContractor}
            placeholder="e.g. DREAMART"
          />
        </Section>

        <Section
          title="Venues"
          subtitle="Exhibition venues with state (one venue per state row)"
          count={master.venues.length}
        >
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                value={venueDraft}
                onChange={(e) => setVenueDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addVenueSubmit(); } }}
                placeholder="e.g. MID VALLEY EXHIBITION CENTRE"
                className={`${inputClass} flex-1`}
              />
              <select
                value={venueState}
                onChange={(e) => setVenueState(e.target.value as MalaysianState)}
                className={`${selectClass} w-32`}
              >
                {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button
                type="button"
                onClick={addVenueSubmit}
                className="h-9 px-3 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>

            <div className="flex items-center gap-2 text-[10px] text-gray-500">
              <span className="font-semibold uppercase tracking-wider">Filter by state:</span>
              <select
                value={filterState}
                onChange={(e) => setFilterState(e.target.value as MalaysianState | "ALL")}
                className="h-7 rounded border border-[#DDE5E5] bg-white px-2 text-[10px] font-semibold text-gray-600"
              >
                <option value="ALL">All states</option>
                {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {filteredVenues.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#DDE5E5] p-4 text-center text-[11px] text-gray-400">
                No venues in this filter
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto divide-y divide-[#F0F3F3] border border-[#DDE5E5] rounded-md">
                {filteredVenues.map((v) => (
                  <div
                    key={`${v.name}|${v.state}`}
                    className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-[#F4F7F7]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold text-[#0A1F2E] truncate">{v.name}</div>
                      <div className="text-[9px] text-gray-500 uppercase tracking-wider">{v.state}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeVenue(v.name, v.state)}
                      className="h-7 w-7 rounded inline-flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 shrink-0"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        <Section
          title="Drivers"
          subtitle="Setup / dismantle drivers (name + phone)"
          count={master.drivers.length}
        >
          <DriverList />
        </Section>

        <Section
          title="Lori (Trucks)"
          subtitle="Truck plates used for booth setup / dismantle"
          count={master.lori.length}
        >
          <SimpleList
            items={master.lori}
            onAdd={addLori}
            onRemove={removeLori}
            placeholder="e.g. VPC9058"
          />
        </Section>
      </div>

      <div className="rounded-md border border-[#DDE5E5] bg-[#F4F7F7] px-4 py-3 text-[10px] text-gray-500">
        <span className="font-semibold text-[#0A1F2E]">Note:</span> Brands (AKEMI, ZANOTTI,
        ERGOTEX, DUNLOPILLO), States (13 Malaysian states) and Event Types (SOLO, EXHIBITION)
        are enum types baked into the codebase and cannot be edited here.
      </div>
    </div>
  );
}
