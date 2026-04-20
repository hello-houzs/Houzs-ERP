import { useState } from "react";
import { Button } from "../components/Button";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";

// ── Projects tab ─────────────────────────────────────────────
// Lookup management for the project module: organizers, venues, and
// the default checklist that's cloned into every new project (per
// event type).

interface OrganizerRow {
  id: number;
  name: string;
  notes: string | null;
  active: number;
}
interface VenueRow {
  id: number;
  name: string;
  state: string | null;
  notes: string | null;
  active: number;
}
interface EventTypeRow {
  id: number;
  slug: string;
  name: string;
  default_template_id: number | null;
  sort_order: number;
}
interface ChecklistTemplate {
  id: number;
  name: string;
  description: string | null;
  item_count: number;
  used_by: string | null;
}
interface ChecklistTemplateItem {
  id: number;
  seq: number;
  title: string;
  description: string | null;
  required_perm: string | null;
  due_offset_days: number | null;
}

export function ProjectMaintenanceView() {
  return (
    <div className="space-y-6">
      <OrganizerManager />
      <VenueManager />
      <ChecklistManager />
    </div>
  );
}

function OrganizerManager() {
  const toast = useToast();
  const q = useQuery<{ data: OrganizerRow[] }>(
    () => api.get("/api/projects/organizers")
  );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/organizers", { name: trimmed });
      setName("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function remove(o: OrganizerRow) {
    if (!confirm(`Remove organizer "${o.name}"? Existing projects keep the value.`)) return;
    try {
      await api.del(`/api/projects/organizers/${o.id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        Organizers
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">
        Picker values for the project Organizer field. Soft delete — existing
        project rows still display whatever name they were saved with.
      </p>

      <div className="mb-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add organizer name…"
          className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">Loading…</li>
        )}
        {q.data?.data.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">No organizers yet.</li>
        )}
        {q.data?.data.map((o) => (
          <li
            key={o.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <span className="text-[12.5px] text-ink">{o.name}</span>
            <button
              onClick={() => remove(o)}
              className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VenueManager() {
  const toast = useToast();
  const q = useQuery<{ data: VenueRow[] }>(() => api.get("/api/projects/venues"));
  const [name, setName] = useState("");
  const [stateField, setStateField] = useState("");
  const [adding, setAdding] = useState(false);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/venues", {
        name: trimmed,
        state: stateField.trim() || null,
      });
      setName("");
      setStateField("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function patch(id: number, body: Record<string, any>) {
    try {
      await api.patch(`/api/projects/venues/${id}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function remove(v: VenueRow) {
    if (!confirm(`Remove venue "${v.name}"? Existing projects keep the value.`)) return;
    try {
      await api.del(`/api/projects/venues/${v.id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        Venues
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">
        Picker values for the project Venue field. Optionally tag each venue
        with a state — picking it on a new project will pre-fill the state.
      </p>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px_auto]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Venue name…"
          className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <input
          value={stateField}
          onChange={(e) => setStateField(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="State (optional)"
          className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">Loading…</li>
        )}
        {q.data?.data.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">No venues yet.</li>
        )}
        {q.data?.data.map((v) => (
          <li
            key={v.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] text-ink">{v.name}</div>
              {v.state && (
                <div className="text-[10.5px] text-ink-muted">{v.state}</div>
              )}
            </div>
            <input
              defaultValue={v.state || ""}
              onBlur={(e) => {
                if (e.target.value !== (v.state || "")) {
                  patch(v.id, { state: e.target.value || null });
                }
              }}
              placeholder="state"
              className="h-7 w-32 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            <button
              onClick={() => remove(v)}
              className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChecklistManager() {
  const toast = useToast();
  const eventTypesQ = useQuery<{ data: EventTypeRow[] }>(
    () => api.get("/api/projects/event-types")
  );
  const templatesQ = useQuery<{ data: ChecklistTemplate[] }>(
    () => api.get("/api/projects/checklist-templates")
  );
  const [activeTemplate, setActiveTemplate] = useState<number | null>(null);

  const templates = templatesQ.data?.data ?? [];
  const eventTypes = eventTypesQ.data?.data ?? [];
  const currentTemplateId = activeTemplate ?? templates[0]?.id ?? null;

  async function setDefaultTemplate(eventTypeId: number, templateId: number | null) {
    try {
      await api.put(
        `/api/projects/event-types/${eventTypeId}/default-template`,
        { template_id: templateId }
      );
      toast.success("Default template updated");
      eventTypesQ.reload();
      templatesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        Default Checklist
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">
        Items in the chosen template are cloned into every new project of that
        event type. Editing here does not affect projects already created.
      </p>

      <div className="mb-4 rounded-md border border-border bg-bg/40 p-3">
        <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Default template per event type
        </div>
        {eventTypesQ.loading ? (
          <div className="text-[11.5px] text-ink-muted">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {eventTypes.map((et) => (
              <label
                key={et.id}
                className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-3 py-2"
              >
                <span className="text-[12px] font-semibold text-ink">{et.name}</span>
                <select
                  value={et.default_template_id ?? ""}
                  onChange={(e) =>
                    setDefaultTemplate(
                      et.id,
                      e.target.value ? parseInt(e.target.value, 10) : null
                    )
                  }
                  className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent"
                >
                  <option value="">— None —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Editing
        </span>
        <select
          value={currentTemplateId ?? ""}
          onChange={(e) => setActiveTemplate(parseInt(e.target.value, 10) || null)}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent"
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.item_count} items
            </option>
          ))}
        </select>
        {currentTemplateId &&
          templates.find((t) => t.id === currentTemplateId)?.used_by && (
            <span className="text-[10.5px] text-ink-muted">
              Used by:{" "}
              {templates.find((t) => t.id === currentTemplateId)?.used_by}
            </span>
          )}
      </div>

      {currentTemplateId && (
        <ChecklistItemsEditor templateId={currentTemplateId} />
      )}
    </section>
  );
}

function ChecklistItemsEditor({ templateId }: { templateId: number }) {
  const toast = useToast();
  const q = useQuery<{ data: ChecklistTemplateItem[] }>(
    () => api.get(`/api/projects/checklist-templates/${templateId}/items`),
    [templateId]
  );
  const [newTitle, setNewTitle] = useState("");
  const [newOffset, setNewOffset] = useState("");
  const [adding, setAdding] = useState(false);

  async function addItem() {
    const t = newTitle.trim();
    if (!t) return;
    setAdding(true);
    try {
      await api.post(`/api/projects/checklist-templates/${templateId}/items`, {
        title: t,
        due_offset_days: newOffset ? parseInt(newOffset, 10) : null,
      });
      setNewTitle("");
      setNewOffset("");
      q.reload();
      toast.success("Item added");
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function patchItem(itemId: number, body: Record<string, any>) {
    try {
      await api.patch(`/api/projects/checklist-templates/items/${itemId}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function removeItem(item: ChecklistTemplateItem) {
    if (!confirm(`Delete checklist item "${item.title}"?`)) return;
    try {
      await api.del(`/api/projects/checklist-templates/items/${item.id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  const items = q.data?.data ?? [];

  return (
    <div>
      <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_auto]">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addItem()}
          placeholder="New item title…"
          className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <input
          value={newOffset}
          onChange={(e) => setNewOffset(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addItem()}
          placeholder="Due offset days"
          type="number"
          className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <Button
          variant="primary"
          onClick={addItem}
          disabled={adding || !newTitle.trim()}
        >
          Add item
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">Loading…</li>
        )}
        {!q.loading && items.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">
            No items yet — add one above.
          </li>
        )}
        {items.map((item) => (
          <li
            key={item.id}
            className="grid grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[60px_1fr_120px_auto] sm:items-center"
          >
            <input
              defaultValue={item.seq}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!isNaN(n) && n !== item.seq) patchItem(item.id, { seq: n });
              }}
              type="number"
              className="h-7 rounded-md border border-border bg-surface px-2 font-mono text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            <input
              defaultValue={item.title}
              onBlur={(e) => {
                if (e.target.value !== item.title)
                  patchItem(item.id, { title: e.target.value });
              }}
              className="h-7 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            <input
              defaultValue={item.due_offset_days ?? ""}
              onBlur={(e) => {
                const n = e.target.value ? parseInt(e.target.value, 10) : null;
                if (n !== item.due_offset_days)
                  patchItem(item.id, { due_offset_days: n });
              }}
              type="number"
              placeholder="Due offset"
              className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            <button
              onClick={() => removeItem(item)}
              className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10.5px] text-ink-muted">
        Seq controls display order (lower first). Due offset days = how many
        days from the project start date the item is due (negative = before
        start).
      </p>
    </div>
  );
}
