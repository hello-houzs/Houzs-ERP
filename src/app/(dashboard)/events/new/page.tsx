"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Save, AlertCircle } from "lucide-react";
import {
  BRANDS, STATES,
  type Brand, type EventType, type EventStatus, type EventProgress,
  type MalaysianState, type HouzsEvent,
} from "@/lib/mock-data";
import { addEvent, buildA42 } from "@/lib/events-store";
import {
  useMasterData,
  addOrganizer,
  addVenue,
  addPic,
  addContractor,
} from "@/lib/master-data-store";
import { Combo } from "@/components/ui/combo";

const MONTHS = [
  "JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE",
  "JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER",
];

function daysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 1;
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#0A1F2E]">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-1">
        {label}
        {required && <span className="text-red-500">*</span>}
      </label>
      <div className="mt-1">{children}</div>
      {hint && <div className="text-[9px] text-gray-400 mt-1">{hint}</div>}
    </div>
  );
}

const inputClass =
  "w-full h-9 rounded-md border border-[#DDE5E5] px-2.5 text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]";
const selectClass = inputClass + " appearance-none cursor-pointer";

export default function NewEventPage() {
  const router = useRouter();
  const master = useMasterData();
  const today = new Date().toISOString().slice(0, 10);
  const inOneWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // Core identity
  const [organizer, setOrganizer] = useState("");
  const [state, setStateField] = useState<MalaysianState>("KL");
  const [venue, setVenue] = useState("");
  const [brand, setBrand] = useState<Brand>("AKEMI");
  const [eventType, setEventType] = useState<EventType>("EXHIBITION");

  // Status / progress
  const [status, setStatus] = useState<EventStatus>("PENDING");
  const [progress, setProgress] = useState<EventProgress>("NOT STARTED");

  // Dates
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(inOneWeek);
  const durationDays = daysBetween(startDate, endDate);

  // Logistics
  const [contractor, setContractor] = useState("DREAMART");
  const [boothNo, setBoothNo] = useState("");
  const [sizeSqm, setSizeSqm] = useState<number>(36);
  const [pic, setPic] = useState("");

  // Finance
  const [totalSalesRm, setTotalSalesRm] = useState<number>(0);
  const [rentalRm, setRentalRm] = useState<number>(0);

  // Integration
  const [linkNotion, setLinkNotion] = useState("");
  const [gcalId, setGcalId] = useState("");

  const [error, setError] = useState<string | null>(null);

  // Derived
  const year = useMemo(() => new Date(startDate).getFullYear() || new Date().getFullYear(), [startDate]);
  const month = useMemo(() => {
    const m = new Date(startDate).getMonth();
    return MONTHS[isNaN(m) ? 0 : m];
  }, [startDate]);

  const a42Preview = useMemo(() => {
    if (!organizer || !venue) return "—";
    try {
      return buildA42({ year, month, organizer, state, venue, brand });
    } catch { return "—"; }
  }, [year, month, organizer, state, venue, brand]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!organizer.trim()) { setError("Organizer is required"); return; }
    if (!venue.trim())      { setError("Venue is required"); return; }
    if (!boothNo.trim())    { setError("Booth number is required"); return; }
    if (new Date(endDate) < new Date(startDate)) {
      setError("End date must be on or after start date"); return;
    }

    const a42 = buildA42({ year, month, organizer, state, venue, brand });

    const newEvent: HouzsEvent = {
      a42,
      status, progress,
      year, month,
      startDate, endDate, durationDays,
      organizer: organizer.trim(),
      state,
      venue: venue.trim(),
      brand, eventType,
      contractor: contractor.trim() || "DREAMART",
      // BD workflow all start blank
      agreementApproval: "",
      floorplan: "",
      boothNo: boothNo.trim(),
      sizeSqm,
      sendFloorplanToDesigner: "",
      threeDCheckedByMgt: "",
      threeDApprovedByPeter: "",
      threeDUploadedInNotion: "",
      weekendActivityTheme: "",
      licenseMajlis: "",
      workLoadingBayPermit: "",
      decoCoffeeTable: "",
      secDepoRefund: "",
      totalSalesRm,
      rentalRm,
      linkNotion: linkNotion.trim() || undefined,
      gcalId: gcalId.trim() || undefined,
      pic: pic.trim() || undefined,
    };

    try {
      addEvent(newEvent);
      router.push("/pms");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create event");
    }
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <Link href="/pms" className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-[#0F766E]">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Project Details
      </Link>

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E]">New Event</h1>
          <p className="text-sm text-gray-500 mt-1">
            Create a new exhibition or solo event — A42 is auto-generated from organizer + state + venue + brand
          </p>
        </div>
        <div className="text-[10px] font-mono text-gray-400 bg-[#F4F7F7] border border-[#DDE5E5] rounded px-2 py-1">
          A42 PREVIEW: <span className="text-[#0A1F2E]">{a42Preview}</span>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 inline-flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        <Section title="Event Identity">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Organizer" required>
              <Combo
                value={organizer}
                options={master.organizers}
                onChange={setOrganizer}
                onCreate={(v) => addOrganizer(v)}
                placeholder="Select organizer…"
              />
            </Field>
            <Field label="Venue" required hint={`Showing venues in ${state}`}>
              <Combo
                value={venue}
                options={master.venues.filter((v) => v.state === state).map((v) => v.name)}
                onChange={setVenue}
                onCreate={(v) => addVenue(v, state)}
                placeholder="Select venue…"
              />
            </Field>
            <Field label="State" required>
              <select
                value={state}
                onChange={(e) => {
                  const next = e.target.value as MalaysianState;
                  setStateField(next);
                  // clear venue if it no longer matches the new state
                  if (venue && !master.venues.some((v) => v.name === venue && v.state === next)) {
                    setVenue("");
                  }
                }}
                className={selectClass}
              >
                {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>

            <Field label="Brand" required>
              <select value={brand} onChange={(e) => setBrand(e.target.value as Brand)} className={selectClass}>
                {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
            <Field label="Event Type" required>
              <select value={eventType} onChange={(e) => setEventType(e.target.value as EventType)} className={selectClass}>
                <option value="EXHIBITION">EXHIBITION</option>
                <option value="SOLO">SOLO</option>
              </select>
            </Field>
            <Field label="PIC">
              <Combo
                value={pic}
                options={master.pics}
                onChange={setPic}
                onCreate={(v) => addPic(v)}
                placeholder="Select PIC…"
              />
            </Field>
          </div>
        </Section>

        <Section title="Status & Dates">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Field label="Status" required>
              <select value={status} onChange={(e) => setStatus(e.target.value as EventStatus)} className={selectClass}>
                <option value="PENDING">PENDING</option>
                <option value="CONFIRMED">CONFIRMED</option>
                <option value="CANCELLED">CANCELLED</option>
              </select>
            </Field>
            <Field label="Progress" required>
              <select value={progress} onChange={(e) => setProgress(e.target.value as EventProgress)} className={selectClass}>
                <option value="NOT STARTED">NOT STARTED</option>
                <option value="IN PROGRESS">IN PROGRESS</option>
                <option value="COMPLETED">COMPLETED</option>
              </select>
            </Field>
            <Field label="Start Date" required>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
            </Field>
            <Field label="End Date" required hint={`Duration: ${durationDays} day${durationDays === 1 ? "" : "s"}`}>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate} className={inputClass} />
            </Field>
          </div>
        </Section>

        <Section title="Booth & Logistics">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Field label="Booth No" required>
              <input value={boothNo} onChange={(e) => setBoothNo(e.target.value)} placeholder="e.g. A12 (6 BOOTH)" className={inputClass} />
            </Field>
            <Field label="Size (SQM)" required>
              <input type="number" step="0.01" min="0" value={sizeSqm} onChange={(e) => setSizeSqm(Number(e.target.value))} className={inputClass} />
            </Field>
            <Field label="Contractor">
              <Combo
                value={contractor}
                options={master.contractors}
                onChange={setContractor}
                onCreate={(v) => addContractor(v)}
                placeholder="Select contractor…"
              />
            </Field>
            <Field label="Notion Link">
              <input type="url" value={linkNotion} onChange={(e) => setLinkNotion(e.target.value)} placeholder="https://notion.so/…" className={inputClass} />
            </Field>
          </div>
        </Section>

        <Section title="Financial">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Total Sales (RM)" hint="Can be updated later from Exhibition Report">
              <input type="number" step="0.01" min="0" value={totalSalesRm} onChange={(e) => setTotalSalesRm(Number(e.target.value))} className={inputClass} />
            </Field>
            <Field label="Rental (RM)">
              <input type="number" step="0.01" min="0" value={rentalRm} onChange={(e) => setRentalRm(Number(e.target.value))} className={inputClass} />
            </Field>
            <Field label="Google Calendar ID">
              <input value={gcalId} onChange={(e) => setGcalId(e.target.value)} placeholder="optional@google.com" className={inputClass} />
            </Field>
          </div>
          <div className="text-[10px] text-gray-400 mt-3">
            COGS, setup, transport, commission &amp; merch costs come from the Exhibition Report sheet once the event runs.
          </div>
        </Section>

        <div className="flex items-center gap-2 justify-end pb-2">
          <Link href="/pms" className="h-9 px-4 rounded-md border border-[#DDE5E5] bg-white text-[12px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center">
            Cancel
          </Link>
          <button type="submit" className="h-9 px-4 rounded-md bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5">
            <Save className="h-4 w-4" /> Create Event
          </button>
        </div>
      </form>
    </div>
  );
}
