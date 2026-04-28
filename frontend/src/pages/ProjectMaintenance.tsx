import { useEffect, useState } from "react";
import { GripVertical, ChevronUp, ChevronDown, Plus, Pencil, Trash2, ShieldCheck, Eye, EyeOff } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { ColorPicker } from "../components/ColorPicker";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { cn } from "../lib/utils";

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
  active?: number;
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
  section_id: number | null;
  requires_review: number; // 0 | 1 — admin-driven flag (mig 050)
}

interface ChecklistTemplateSection {
  id: number;
  name: string;
  sort_order: number;
}

export function ProjectMaintenanceView() {
  return (
    <div>
      <PageHeader
        eyebrow="Operations · Projects"
        title="Project Maintenance"
        description="All the picker lists that drive the new-project form: brands, event types, organizers, venues, plus the default checklist that clones into every new project."
      />
      <div className="space-y-6">
        <BrandManager />
        <EventTypeManager />
        <OrganizerManager />
        <VenueManager />
        <ChecklistManager />
      </div>
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
            <span className="flex-1 text-[12.5px] text-ink">{o.name}</span>
            <RowActionsMenu
              items={[
                {
                  type: "action",
                  icon: Trash2,
                  label: "Remove",
                  danger: true,
                  onClick: () => remove(o),
                },
              ]}
            />
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
            <RowActionsMenu
              items={[
                {
                  type: "action",
                  icon: Trash2,
                  label: "Remove",
                  danger: true,
                  onClick: () => remove(v),
                },
              ]}
            />
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

// RowActionsMenu and ColorPicker live in ../components for reuse.

function ChecklistItemsEditor({ templateId }: { templateId: number }) {
  const toast = useToast();
  const q = useQuery<{
    data: ChecklistTemplateItem[];
    sections: ChecklistTemplateSection[];
  }>(
    () => api.get(`/api/projects/checklist-templates/${templateId}/items`),
    [templateId]
  );
  // Per-section quick-add. Tracks which section's "Add task" form is
  // open + the title being typed.
  const [addInSectionId, setAddInSectionId] = useState<number | null | "_none">(null);
  const [newTitle, setNewTitle] = useState("");
  const [newOffset, setNewOffset] = useState("");
  const [adding, setAdding] = useState(false);
  // Tracks which section a drag is currently hovering over so we can
  // tint the drop zone. Null = not dragging into any section.
  const [dragOverSectionKey, setDragOverSectionKey] = useState<string | null>(null);

  // Section management state
  const [newSectionName, setNewSectionName] = useState("");
  const [editingSectionId, setEditingSectionId] = useState<number | null>(null);
  const [editingSectionName, setEditingSectionName] = useState("");
  const [addingSection, setAddingSection] = useState(false);

  const sections = q.data?.sections ?? [];

  async function addSection() {
    const n = newSectionName.trim();
    if (!n) return;
    setAddingSection(true);
    try {
      await api.post(`/api/projects/checklist-templates/${templateId}/sections`, {
        name: n,
      });
      setNewSectionName("");
      q.reload();
      toast.success("Section added");
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAddingSection(false);
    }
  }

  async function renameSection(id: number) {
    const n = editingSectionName.trim();
    if (!n) return;
    try {
      await api.patch(`/api/projects/checklist-templates/sections/${id}`, {
        name: n,
      });
      setEditingSectionId(null);
      setEditingSectionName("");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function deleteSection(id: number, name: string) {
    if (
      !confirm(
        `Delete section "${name}"? Template items in it will move to Uncategorised.`
      )
    )
      return;
    try {
      await api.del(`/api/projects/checklist-templates/sections/${id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  // Reorder a section by one slot. The order here propagates to every
  // project cloned from this template, which drives the stage-chip
  // progress bar at the top of the project detail page.
  async function moveSection(sectionId: number, delta: -1 | 1) {
    const idx = sections.findIndex((s) => s.id === sectionId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= sections.length) return;
    const next = sections.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      await api.put(
        `/api/projects/checklist-templates/${templateId}/sections/reorder`,
        { ids: next.map((s) => s.id) }
      );
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reorder");
    }
  }

  // Local order overrides server data while a reorder is in flight, so
  // the UI feels instant. Reset whenever the server payload changes.
  const [localOrder, setLocalOrder] = useState<ChecklistTemplateItem[] | null>(
    null
  );
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  useEffect(() => {
    if (q.data?.data) setLocalOrder(q.data.data);
  }, [q.data?.data]);

  const items = localOrder ?? q.data?.data ?? [];

  async function addItem(targetSectionId: number | null) {
    const t = newTitle.trim();
    if (!t) return;
    setAdding(true);
    try {
      await api.post(`/api/projects/checklist-templates/${templateId}/items`, {
        title: t,
        due_offset_days: newOffset ? parseInt(newOffset, 10) : null,
        section_id: targetSectionId,
      });
      setNewTitle("");
      setNewOffset("");
      // Keep the form open in the same section so admins can batch-add
      // multiple tasks per stage without re-clicking.
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

  // Push the proposed order to the server. The local state has already
  // been updated; on failure we reload to bring the server's truth back.
  async function persistOrder(next: ChecklistTemplateItem[]) {
    try {
      await api.put(
        `/api/projects/checklist-templates/${templateId}/items/reorder`,
        { ids: next.map((i) => i.id) }
      );
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reorder");
      q.reload();
    }
  }

  function moveBy(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= items.length) return;
    const next = items.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    setLocalOrder(next);
    persistOrder(next);
  }

  function onDragStart(e: React.DragEvent, id: number) {
    e.dataTransfer.setData("text/plain", String(id));
    e.dataTransfer.effectAllowed = "move";
    setDragId(id);
  }
  function onDragOver(e: React.DragEvent, overId: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverId !== overId) setDragOverId(overId);
  }
  function onDragLeaveRow(overId: number) {
    if (dragOverId === overId) setDragOverId(null);
  }
  function onDrop(e: React.DragEvent, targetId: number) {
    e.preventDefault();
    setDragOverId(null);
    setDragOverSectionKey(null);
    const sourceId = parseInt(e.dataTransfer.getData("text/plain"), 10);
    setDragId(null);
    if (!sourceId || sourceId === targetId) return;
    const sourceIdx = items.findIndex((i) => i.id === sourceId);
    const targetIdx = items.findIndex((i) => i.id === targetId);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const source = items[sourceIdx];
    const target = items[targetIdx];
    const next = items.slice();
    const [moved] = next.splice(sourceIdx, 1);
    // Cross-section drop: inherit the target row's section before
    // splicing in, so the persisted order + section_id agree.
    const movedNew = { ...moved, section_id: target.section_id };
    const targetIdxAdj =
      sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
    next.splice(targetIdxAdj, 0, movedNew);
    setLocalOrder(next);
    if (source.section_id !== target.section_id) {
      // Patch the item's section_id first, then persist the new order.
      // Sequential awaits since reorder relies on the section move
      // already being durable.
      (async () => {
        try {
          await api.patch(`/api/projects/checklist-templates/items/${source.id}`, {
            section_id: target.section_id,
          });
          await persistOrder(next);
        } catch (e: any) {
          toast.error(e?.message || "Failed to move");
          q.reload();
        }
      })();
    } else {
      persistOrder(next);
    }
  }

  // Drop on a section block (header or empty area). Moves the dragged
  // item into this section and parks it at the end of that section's
  // existing items. Avoids the row-on-row collision when a section is
  // empty or the user wants to append rather than insert before a row.
  async function onDropOnSection(
    e: React.DragEvent,
    sectionId: number | null
  ) {
    e.preventDefault();
    setDragOverSectionKey(null);
    const sourceId = parseInt(e.dataTransfer.getData("text/plain"), 10);
    setDragId(null);
    if (!sourceId) return;
    const sourceIdx = items.findIndex((i) => i.id === sourceId);
    if (sourceIdx < 0) return;
    const source = items[sourceIdx];
    if ((source.section_id ?? null) === sectionId) {
      // Already in this section — nothing to do at the section level.
      return;
    }
    // Move the row to just after the last item in the target section
    // (or to the end if that section is empty).
    const next = items.slice();
    const [moved] = next.splice(sourceIdx, 1);
    moved.section_id = sectionId;
    let insertAt = next.length;
    for (let i = next.length - 1; i >= 0; i--) {
      if ((next[i].section_id ?? null) === sectionId) {
        insertAt = i + 1;
        break;
      }
    }
    next.splice(insertAt, 0, moved);
    setLocalOrder(next);
    try {
      await api.patch(`/api/projects/checklist-templates/items/${source.id}`, {
        section_id: sectionId,
      });
      await persistOrder(next);
    } catch (err: any) {
      toast.error(err?.message || "Failed to move");
      q.reload();
    }
  }

  function onDragOverSection(e: React.DragEvent, key: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverSectionKey !== key) setDragOverSectionKey(key);
  }

  return (
    <div>
      {/* Sections (mig 050) — define stages that group template items.
          Project-level sections are cloned from these on project create. */}
      <div className="mb-3 rounded-md border border-border bg-bg/40 p-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Sections (stages)
          </span>
          <span className="font-mono text-[9.5px] text-ink-muted/70">
            {sections.length} defined
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {sections.map((s, idx) =>
            editingSectionId === s.id ? (
              <span
                key={s.id}
                className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent-soft px-1 py-0.5"
              >
                <input
                  value={editingSectionName}
                  onChange={(e) => setEditingSectionName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") renameSection(s.id);
                    if (e.key === "Escape") setEditingSectionId(null);
                  }}
                  autoFocus
                  className="h-5 w-32 rounded bg-surface px-1.5 text-[11px] outline-none"
                />
                <button
                  onClick={() => renameSection(s.id)}
                  className="rounded bg-accent px-1 py-0.5 font-mono text-[8.5px] font-semibold uppercase text-white"
                >
                  Save
                </button>
              </span>
            ) : (
              <span
                key={s.id}
                className="group inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-secondary"
              >
                {/* Reorder arrows — order here propagates to every
                    project cloned from this template, driving the
                    stage progress bar's left-to-right order. */}
                <button
                  onClick={() => moveSection(s.id, -1)}
                  disabled={idx === 0}
                  className="opacity-50 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                  title="Move left"
                >
                  <ChevronUp size={10} className="-rotate-90" />
                </button>
                <button
                  onClick={() => moveSection(s.id, 1)}
                  disabled={idx === sections.length - 1}
                  className="opacity-50 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                  title="Move right"
                >
                  <ChevronDown size={10} className="-rotate-90" />
                </button>
                <span>{s.name}</span>
                <button
                  onClick={() => {
                    setEditingSectionId(s.id);
                    setEditingSectionName(s.name);
                  }}
                  className="opacity-50 hover:opacity-100"
                  title="Rename"
                >
                  <Pencil size={10} />
                </button>
                <button
                  onClick={() => deleteSection(s.id, s.name)}
                  className="opacity-50 hover:text-err hover:opacity-100"
                  title="Delete"
                >
                  <Trash2 size={10} />
                </button>
              </span>
            )
          )}
          <input
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSection()}
            placeholder="New section…"
            className="h-7 w-44 rounded-md border border-dashed border-border bg-surface px-2 text-[11.5px] outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
          />
          <button
            onClick={addSection}
            disabled={addingSection || !newSectionName.trim()}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
          >
            <Plus size={10} className="inline-block mr-0.5" />
            Add
          </button>
        </div>
        {sections.length === 0 && (
          <p className="mt-1 text-[10px] text-ink-muted">
            No sections yet. Without sections, all template items land in
            "Uncategorised" on each project.
          </p>
        )}
      </div>

      {q.loading && items.length === 0 && (
        <div className="rounded-md border border-border bg-bg/40 px-3 py-3 text-[11.5px] text-ink-muted">
          Loading…
        </div>
      )}

      {/* Section-keyed blocks. Each block is a drop zone — drop a row
          onto it to move the row into that section. Reordering within
          a section uses the row-on-row drop (cross-section drop also
          works that way; the row inherits the target's section). */}
      {!q.loading &&
        (() => {
          const blocks: Array<{
            key: string;
            sectionId: number | null;
            name: string;
            items: ChecklistTemplateItem[];
          }> = [];
          for (const s of sections) {
            blocks.push({
              key: `s-${s.id}`,
              sectionId: s.id,
              name: s.name,
              items: items.filter((it) => it.section_id === s.id),
            });
          }
          const uncat = items.filter((it) => it.section_id == null);
          if (uncat.length > 0 || sections.length === 0) {
            blocks.push({
              key: "s-none",
              sectionId: null,
              name: "Uncategorised",
              items: uncat,
            });
          }
          return (
            <div className="space-y-2">
              {blocks.map((block) => {
                const isDropTarget =
                  dragOverSectionKey === block.key && dragId != null;
                const addOpenHere =
                  addInSectionId ===
                  (block.sectionId == null ? "_none" : block.sectionId);
                return (
                  <div
                    key={block.key}
                    onDragOver={(e) => onDragOverSection(e, block.key)}
                    onDragLeave={() => {
                      if (dragOverSectionKey === block.key)
                        setDragOverSectionKey(null);
                    }}
                    onDrop={(e) => onDropOnSection(e, block.sectionId)}
                    className={cn(
                      "rounded-md border bg-bg/40 transition-colors",
                      isDropTarget
                        ? "border-accent bg-accent-soft/30"
                        : "border-border"
                    )}
                  >
                    {/* Block header */}
                    <div className="flex items-center gap-2 border-b border-border-subtle bg-bg/60 px-3 py-1.5">
                      <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-brand text-ink-secondary">
                        {block.name}
                      </span>
                      <span className="font-mono text-[10px] text-ink-muted">
                        {block.items.length}
                      </span>
                      <button
                        onClick={() =>
                          setAddInSectionId(
                            addOpenHere
                              ? null
                              : block.sectionId == null
                              ? "_none"
                              : block.sectionId
                          )
                        }
                        className="rounded p-0.5 text-ink-muted hover:bg-surface-dim hover:text-accent"
                        title="Add task to this section"
                      >
                        <Plus size={12} />
                      </button>
                    </div>

                    {/* Block rows */}
                    <ul className="divide-y divide-border-subtle">
                      {block.items.length === 0 && !addOpenHere && (
                        <li className="px-3 py-3 text-[10.5px] italic text-ink-muted">
                          Drop a task here, or click <Plus size={10} className="inline" /> above to add one.
                        </li>
                      )}
                      {block.items.map((item) => {
                        const idx = items.findIndex((i) => i.id === item.id);
                        const blockIdx = block.items.findIndex(
                          (i) => i.id === item.id
                        );
                        const isDragging = dragId === item.id;
                        const isRowDropTarget =
                          dragOverId === item.id && dragId !== item.id;
                        return (
                          <li
                            key={item.id}
                            draggable
                            onDragStart={(e) => onDragStart(e, item.id)}
                            onDragOver={(e) => {
                              e.stopPropagation();
                              onDragOver(e, item.id);
                            }}
                            onDragLeave={() => onDragLeaveRow(item.id)}
                            onDrop={(e) => {
                              e.stopPropagation();
                              onDrop(e, item.id);
                            }}
                            onDragEnd={() => {
                              setDragId(null);
                              setDragOverId(null);
                              setDragOverSectionKey(null);
                            }}
                            className={cn(
                              "grid grid-cols-1 gap-2 px-3 py-2 transition-colors sm:grid-cols-[auto_1fr_120px_auto] sm:items-center",
                              isDragging && "opacity-40",
                              isRowDropTarget && "bg-accent-soft/40"
                            )}
                          >
                            {/* Drag handle + arrow controls */}
                            <div className="flex items-center gap-0.5 text-ink-muted">
                              <span
                                className="cursor-grab rounded p-1 hover:bg-bg/70 active:cursor-grabbing"
                                title="Drag to reorder or move between sections"
                                aria-label="Drag handle"
                              >
                                <GripVertical size={14} />
                              </span>
                              <button
                                type="button"
                                onClick={() => moveBy(idx, -1)}
                                disabled={blockIdx === 0}
                                title="Move up"
                                aria-label="Move up"
                                className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <ChevronUp size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveBy(idx, 1)}
                                disabled={blockIdx === block.items.length - 1}
                                title="Move down"
                                aria-label="Move down"
                                className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <ChevronDown size={14} />
                              </button>
                              <span className="ml-1 font-mono text-[10px] text-ink-muted/70">
                                {blockIdx + 1}
                              </span>
                            </div>
                            <input
                              defaultValue={item.title}
                              key={`title-${item.id}-${item.title}`}
                              onBlur={(e) => {
                                if (e.target.value !== item.title)
                                  patchItem(item.id, { title: e.target.value });
                              }}
                              className="h-7 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
                            />
                            <input
                              defaultValue={item.due_offset_days ?? ""}
                              key={`offset-${item.id}-${item.due_offset_days ?? ""}`}
                              onBlur={(e) => {
                                const n = e.target.value
                                  ? parseInt(e.target.value, 10)
                                  : null;
                                if (n !== item.due_offset_days)
                                  patchItem(item.id, { due_offset_days: n });
                              }}
                              type="number"
                              placeholder="Due offset"
                              className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
                            />
                            {/* Row actions — both "Need review" and
                                Delete moved into a single ellipsis
                                menu so the visible row only carries
                                handle / title / offset / menu. The
                                trigger gets a tiny brass dot when the
                                template item is review-gated, so admins
                                can scan the list without opening every
                                menu. */}
                            <RowActionsMenu
                              indicator={!!item.requires_review}
                              items={[
                                {
                                  type: "toggle",
                                  icon: ShieldCheck,
                                  label: "Need review",
                                  active: !!item.requires_review,
                                  onClick: () =>
                                    patchItem(item.id, {
                                      requires_review: !item.requires_review,
                                    }),
                                },
                                {
                                  type: "action",
                                  icon: Trash2,
                                  label: "Delete",
                                  danger: true,
                                  onClick: () => removeItem(item),
                                },
                              ]}
                            />
                          </li>
                        );
                      })}
                      {/* Inline quick-add inside the section */}
                      {addOpenHere && (
                        <li className="grid grid-cols-1 gap-2 bg-bg/30 px-3 py-2 sm:grid-cols-[1fr_140px_auto_auto] sm:items-center">
                          <input
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") addItem(block.sectionId);
                              if (e.key === "Escape") {
                                setAddInSectionId(null);
                                setNewTitle("");
                                setNewOffset("");
                              }
                            }}
                            placeholder="New task title…"
                            autoFocus
                            className="h-8 rounded-md border border-accent/40 bg-surface px-2 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
                          />
                          <input
                            value={newOffset}
                            onChange={(e) => setNewOffset(e.target.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && addItem(block.sectionId)
                            }
                            placeholder="Due offset days"
                            type="number"
                            className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
                          />
                          <Button
                            variant="primary"
                            onClick={() => addItem(block.sectionId)}
                            disabled={adding || !newTitle.trim()}
                          >
                            Add
                          </Button>
                          <button
                            onClick={() => {
                              setAddInSectionId(null);
                              setNewTitle("");
                              setNewOffset("");
                            }}
                            className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
                          >
                            Cancel
                          </button>
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          );
        })()}

      <p className="mt-2 text-[10.5px] text-ink-muted">
        Drag a row's handle to reorder within a section, or drop it on a
        different section's block to move it. The "Mgmt review" toggle
        flags tasks that need approval before they can be ticked done on
        a project.
      </p>
    </div>
  );
}

// ── Brand manager ────────────────────────────────────────────
// Brands live in project_brands (migration 044). Colour shows up on
// the calendar and list chips; sort_order decides dropdown position.

const BRAND_PALETTE = [
  "64748b", "3b82f6", "06b6d4", "10b981",
  "f59e0b", "f97316", "ec4899", "8b5cf6",
];

interface BrandRow {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  active: number;
}

function BrandManager() {
  const toast = useToast();
  const q = useQuery<{ data: BrandRow[] }>(() =>
    api.get("/api/projects/brands?full=1&include_inactive=1")
  );
  const [name, setName] = useState("");
  const [color, setColor] = useState(BRAND_PALETTE[3]);
  const [adding, setAdding] = useState(false);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/brands", {
        name: trimmed,
        color,
        sort_order: (q.data?.data.length ?? 0) * 10,
      });
      setName("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function patch(
    b: BrandRow,
    body: Partial<Omit<BrandRow, "active">> & { active?: boolean }
  ) {
    try {
      await api.patch(`/api/projects/brands/${b.id}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function remove(b: BrandRow) {
    if (
      !confirm(
        `Hide "${b.name}" from the picker? Existing projects keep their brand label; you can re-enable later.`
      )
    )
      return;
    try {
      await api.del(`/api/projects/brands/${b.id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        Brands
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">
        Shown in the project Brand dropdown and coloured chips. Renames cascade
        to existing projects so historical data stays in sync.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New brand name…"
          className="h-9 min-w-[200px] flex-1 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <ColorPicker
          value={color}
          onChange={setColor}
          presets={BRAND_PALETTE}
          size={32}
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
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">
            No brands configured.
          </li>
        )}
        {q.data?.data.map((b) => (
          <li
            key={b.id}
            className={cn(
              "flex flex-wrap items-center gap-3 px-3 py-2",
              !b.active && "opacity-50"
            )}
          >
            <ColorPicker
              value={b.color}
              onChange={(hex) => patch(b, { color: hex })}
              presets={BRAND_PALETTE}
              size={24}
            />
            <input
              defaultValue={b.name}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== b.name) patch(b, { name: v });
              }}
              className="flex-1 min-w-[140px] h-8 rounded-md border border-transparent bg-transparent px-2 text-[12.5px] font-semibold text-ink hover:border-border focus:border-accent focus:bg-surface focus:ring-1 focus:ring-accent/20 focus:outline-none"
            />
            <input
              type="number"
              defaultValue={b.sort_order}
              onBlur={(e) => {
                const v = parseInt(e.target.value, 10) || 0;
                if (v !== b.sort_order) patch(b, { sort_order: v });
              }}
              title="Sort order"
              className="h-8 w-16 rounded-md border border-border bg-surface px-2 font-mono text-[11px]"
            />
            <span
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
                b.active ? "bg-synced/15 text-synced" : "bg-bg text-ink-muted"
              )}
            >
              {b.active ? "Active" : "Hidden"}
            </span>
            <RowActionsMenu
              indicator={!b.active}
              items={[
                {
                  type: "toggle",
                  icon: b.active ? Eye : EyeOff,
                  label: b.active ? "Active" : "Hidden",
                  active: !!b.active,
                  onClick: () => patch(b, { active: !b.active }),
                },
                {
                  type: "action",
                  icon: Trash2,
                  label: "Hide from picker",
                  danger: true,
                  onClick: () => remove(b),
                },
              ]}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Event type manager ──────────────────────────────────────
// project_event_types has existed since 021; this UI was missing.

function EventTypeManager() {
  const toast = useToast();
  const q = useQuery<{ data: EventTypeRow[] }>(() =>
    api.get("/api/projects/event-types?include_inactive=1")
  );
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/event-types", {
        name: trimmed,
        sort_order: (q.data?.data.length ?? 0) * 10,
      });
      setName("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function patch(t: EventTypeRow, body: any) {
    try {
      await api.patch(`/api/projects/event-types/${t.id}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function remove(t: EventTypeRow) {
    if (
      !confirm(
        `Hide "${t.name}" from the picker? Existing projects keep their event type.`
      )
    )
      return;
    try {
      await api.del(`/api/projects/event-types/${t.id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        Event Types
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">
        Shown in the "Event Type" dropdown when creating a project. Setting
        a default checklist template on a type auto-seeds the checklist for
        every new project of that type.
      </p>

      <div className="mb-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New event type name…"
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
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">
            No event types yet.
          </li>
        )}
        {q.data?.data.map((t) => {
          const active = (t as any).active !== 0;
          return (
            <li
              key={t.id}
              className={cn(
                "flex flex-wrap items-center gap-3 px-3 py-2",
                !active && "opacity-50"
              )}
            >
              <input
                defaultValue={t.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== t.name) patch(t, { name: v });
                }}
                className="flex-1 min-w-[160px] h-8 rounded-md border border-transparent bg-transparent px-2 text-[12.5px] font-semibold text-ink hover:border-border focus:border-accent focus:bg-surface focus:ring-1 focus:ring-accent/20 focus:outline-none"
              />
              <span className="font-mono text-[10px] text-ink-muted">
                {t.slug}
              </span>
              <input
                type="number"
                defaultValue={t.sort_order}
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10) || 0;
                  if (v !== t.sort_order) patch(t, { sort_order: v });
                }}
                title="Sort order"
                className="h-8 w-16 rounded-md border border-border bg-surface px-2 font-mono text-[11px]"
              />
              <span
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
                  active ? "bg-synced/15 text-synced" : "bg-bg text-ink-muted"
                )}
              >
                {active ? "Active" : "Hidden"}
              </span>
              <RowActionsMenu
                indicator={!active}
                items={[
                  {
                    type: "toggle",
                    icon: active ? Eye : EyeOff,
                    label: active ? "Active" : "Hidden",
                    active,
                    onClick: () => patch(t, { active: !active }),
                  },
                  {
                    type: "action",
                    icon: Trash2,
                    label: "Hide from picker",
                    danger: true,
                    onClick: () => remove(t),
                  },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
