import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import "./mobile.css";

// Mirrors the desktop PROJECT_STATES exactly (uppercase; venue.state matches these).
const PROJECT_STATES = [
  "JOHOR", "KEDAH", "KELANTAN", "KL", "LABUAN", "MELAKA", "NEGERI SEMBILAN",
  "PAHANG", "PENANG", "PERAK", "PERLIS", "PUTRAJAYA", "SABAH", "SARAWAK",
  "SELANGOR", "TERENGGANU",
];

type EventType = { id: number; name: string; slug?: string | null };

// Mirrors the desktop composeDefaultProjectName: "{state} [{brand}] {organizer|SOLO} @ {venue}".
function composeName(p: { state: string; brand: string; organizer: string; venue: string; solo: boolean }): string {
  const state = p.state.trim();
  const brand = p.brand.trim();
  const venue = p.venue.trim();
  const orgSlot = p.solo ? "SOLO" : p.organizer.trim();
  const head: string[] = [];
  if (state) head.push(state);
  if (brand) head.push(`[${brand}]`);
  if (orgSlot) head.push(orgSlot);
  const left = head.join(" ");
  if (!venue) return left;
  if (!left) return `@ ${venue}`;
  return `${left} @ ${venue}`;
}

/** Mobile "New Project" form — parity with the desktop CreateProjectPanel.
 *  POSTs /api/projects and hands the new id back so the caller can open it. */
export function MobileNewProject({ onBack, onCreated }: { onBack: () => void; onCreated: (id: number) => void }) {
  const notify = useNotify();
  const [eventTypeId, setEventTypeId] = useState("");
  const [brand, setBrand] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [venue, setVenue] = useState("");
  const [stateName, setStateName] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const brandsQ = useQuery({ queryKey: ["proj-brands"], queryFn: () => api.get<{ data: string[] }>("/api/projects/brands"), staleTime: 300_000 });
  const eventTypesQ = useQuery({ queryKey: ["proj-event-types"], queryFn: () => api.get<{ data: EventType[] }>("/api/projects/event-types"), staleTime: 300_000 });
  const venuesQ = useQuery({ queryKey: ["proj-venues"], queryFn: () => api.get<{ data: Array<{ id: number; name: string; state?: string | null }> }>("/api/projects/venues"), staleTime: 300_000 });
  const organizersQ = useQuery({ queryKey: ["proj-organizers"], queryFn: () => api.get<{ data: Array<{ id: number; name: string }> }>("/api/projects/organizers"), staleTime: 300_000 });

  const brands = brandsQ.data?.data ?? [];
  const eventTypes = eventTypesQ.data?.data ?? [];
  const venues = venuesQ.data?.data ?? [];
  const organizers = organizersQ.data?.data ?? [];

  const eventSlug = eventTypes.find((t) => String(t.id) === eventTypeId)?.slug ?? null;
  const isSolo = (eventSlug ?? "").toLowerCase() === "solo";
  const derivedName = composeName({ state: stateName, brand, organizer, venue, solo: isSolo });
  const dateInvalid = !!startDate && !!endDate && endDate < startDate;
  const canSubmit = !submitting && !!brand && !!venue.trim() && !!stateName.trim() && !!derivedName.trim() && !dateInvalid;

  const onVenueChange = (v: string) => {
    setVenue(v);
    const match = venues.find((x) => x.name === v);
    if (match?.state) setStateName(match.state);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ id: number; code: string }>("/api/projects", {
        name: derivedName.trim(),
        event_type_id: eventTypeId ? parseInt(eventTypeId, 10) : undefined,
        brand: brand || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        venue: venue.trim(),
        state: stateName.trim() || undefined,
        organizer: organizer.trim() || undefined,
      });
      onCreated(res.id);
    } catch (e) {
      await notify({ title: "Couldn't create project", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button type="button" onClick={onBack} style={{ background: "none", border: "none", color: "var(--mut)", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Cancel</button>
        </div>
        <div className="scr-title" style={{ marginTop: 6 }}>New Project</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 28 }}>
        {/* Auto-derived name preview */}
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093", marginBottom: 5 }}>Project name (auto)</div>
        <div style={{ border: "1px dashed #d6d9d2", borderRadius: 9, padding: "9px 11px", fontSize: 13, fontWeight: 600, color: derivedName ? "#11140f" : "#9aa093", marginBottom: 14 }}>
          {derivedName || "Pick brand, venue & state to derive…"}
        </div>

        <label className="fld" style={{ marginBottom: 10 }}>
          <span className="fld-l">Event type</span>
          <select className="fld-i" value={eventTypeId} onChange={(e) => setEventTypeId(e.target.value)}>
            <option value="">— none —</option>
            {eventTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>

        <label className="fld" style={{ marginBottom: 10 }}>
          <span className="fld-l">Brand *</span>
          <select className="fld-i" value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">— select brand —</option>
            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>

        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <label className="fld" style={{ flex: 1 }}>
            <span className="fld-l">Start date</span>
            <input className="fld-i" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="fld" style={{ flex: 1 }}>
            <span className="fld-l">End date</span>
            <input className="fld-i" type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>
        {dateInvalid && <div style={{ fontSize: 11, color: "#a13a34", margin: "-4px 0 10px" }}>End date can't be before the start date.</div>}

        <label className="fld" style={{ marginBottom: 10 }}>
          <span className="fld-l">Venue *</span>
          <select className="fld-i" value={venue} onChange={(e) => onVenueChange(e.target.value)}>
            <option value="">— select venue —</option>
            {venues.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
          </select>
        </label>

        <label className="fld" style={{ marginBottom: 10 }}>
          <span className="fld-l">State *</span>
          <select className="fld-i" value={stateName} onChange={(e) => setStateName(e.target.value)}>
            <option value="">— select state —</option>
            {PROJECT_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label className="fld" style={{ marginBottom: 16 }}>
          <span className="fld-l">Organizer{isSolo ? " (SOLO event)" : ""}</span>
          <select className="fld-i" value={organizer} disabled={isSolo} onChange={(e) => setOrganizer(e.target.value)}>
            <option value="">{isSolo ? "SOLO — no organizer" : "— none —"}</option>
            {organizers.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
          </select>
        </label>

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
          style={{
            width: "100%", padding: "12px", borderRadius: 11, border: "none",
            background: canSubmit ? "#16695f" : "#c9cec4", color: "#fff",
            fontWeight: 800, fontSize: 14, fontFamily: "inherit",
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          {submitting ? "Creating…" : "Create Project"}
        </button>
        <div style={{ fontSize: 10.5, color: "#9aa093", marginTop: 8, textAlign: "center" }}>
          Need a new venue or organizer? Add it on the desktop first.
        </div>
      </div>
    </div>
  );
}
