/**
 * Supplier Portal — service request view.
 *
 * Layout mirrors Mr Lim's "SUPPLIER SERVICE REQUEST" reference:
 *   - top metadata strip: ASSR NO · Request Date · Category
 *   - strip 2: Ref No · PO No · Service Category
 *   - Supplier Info: Supplier Name · Service Status (current stage)
 *   - Problem Description (full width)
 *   - Items table (fixed 5-row shape — empty rows visible for completeness)
 *   - Service Issue + Operation QC Checked picture panels (side by side)
 *   - Proof of Service: Supplier Pickup Date · Supplier Ready Date ·
 *     Proof of Pickup Date · Proof of Return Date (WH signature placeholders)
 *   - Supplier Remarks (left) + Warehouse Acknowledgement (right)
 *   - Footer: Print Supplier Template / Back
 *
 * Auth: token in URL (/portal/supplier/:token). No localStorage —
 * link IS the auth, matching the customer portal model.
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Printer, Trash2, Upload } from "lucide-react";
import { portalApi } from "../portalApi";
import { PortalFrame } from "../components/PortalFrame";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { useDialog } from "../../hooks/useDialog";

const ALLOWED_EXT = ["jpg", "jpeg", "png", "webp"];
const MAX_SIZE = 10 * 1024 * 1024;

// ── Types (mirror backend supplierPortal.ts response) ──────────────

type SupplierCase = {
  case: {
    id: number;
    assr_no: string;
    stage: string;
    complained_date: string | null;
    complaint_issue: string | null;
    issue_category: string | null;
    resolution_method: string | null;
    service_category: string | null;
    po_no: string | null;
    ref_no: string | null;
    addr1: string | null;
    addr4: string | null;
    location: string | null;
    customer_name: string | null;
    supplier_pickup_at: string | null;
    items_ready_at: string | null;
    do_date: string | null;
    delivery_order: string | null;
    creditor_code: string | null;
    stage_entered_at: string | null;
    stage_target_days: number | null;
  };
  supplier_name: string | null;
  items: Array<{
    id: number;
    item_code: string;
    item_description: string | null;
    qty: number | null;
  }>;
  attachments: Array<{
    id: number;
    category: string;
    file_name: string | null;
    content_type: string | null;
    created_at: string;
  }>;
  stage_history: Array<{
    id: number;
    stage: string;
    entered_at: string;
    exited_at: string | null;
    target_days: number | null;
    status: string | null;
    skipped: number;
    skip_reason: string | null;
  }>;
};

const STAGE_LABEL: Record<string, string> = {
  pending_review: "Pending Review",
  under_verification: "Under Verification",
  pending_solution: "Pending Solution",
  pending_inspection: "Pending Inspection",
  pending_item_pickup: "Pending Item Pickup",
  pending_supplier_pickup: "Pending Supplier Pickup",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Pending Delivery / Service",
  completed: "Completed",
};

const ALLOWED_STAGE_ACTIONS: { value: string; label: string }[] = [
  { value: "pending_supplier_pickup", label: "Picked up from warehouse" },
  { value: "pending_item_ready", label: "Repair complete (ready)" },
  { value: "pending_delivery_service", label: "Returned to Houzs warehouse" },
];

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s.endsWith("Z") ? s : s + "Z");
  if (isNaN(d.getTime())) return s.slice(0, 10);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// ── Page ───────────────────────────────────────────────────────────

export function PortalSupplierCasePage() {
  const { token = "" } = useParams();
  const nav = useNavigate();
  const dialog = useDialog();

  const [data, setData] = useState<SupplierCase | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingStage, setSubmittingStage] = useState<string | null>(null);
  const [remark, setRemark] = useState("");
  const [savingRemark, setSavingRemark] = useState(false);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const d = await portalApi.get<SupplierCase>("/api/supplier-portal/case", token);
      setData(d);
    } catch (e: any) {
      setErr(e?.message || "Could not load case");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [token]);

  async function moveStage(stage: string) {
    setSubmittingStage(stage);
    try {
      await portalApi.post("/api/supplier-portal/stage", token, { stage });
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to update stage");
    } finally {
      setSubmittingStage(null);
    }
  }

  async function postRemark() {
    const note = remark.trim();
    if (!note) return;
    setSavingRemark(true);
    try {
      await portalApi.post("/api/supplier-portal/remarks", token, { note });
      setRemark("");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to post remark");
    } finally {
      setSavingRemark(false);
    }
  }

  // Upload a photo into one of the two PictureBlock slots. Category
  // maps to the existing assr_attachments CHECK constraint:
  //   evidence   → "Service Issue" slot
  //   completion → "Operation QC Checked" slot
  async function uploadPhoto(f: File, category: "evidence" | "completion") {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      setErr(`Unsupported file type: .${ext}`);
      return;
    }
    if (f.size > MAX_SIZE) {
      setErr("File exceeds 10 MB");
      return;
    }
    setUploadingSlot(category);
    setErr(null);
    try {
      const buf = await f.arrayBuffer();
      await portalApi.putBinary(
        `/api/supplier-portal/attachments?ext=${ext}&category=${category}&name=${encodeURIComponent(f.name)}`,
        token,
        buf,
        f.type || "image/jpeg"
      );
      await load();
    } catch (e: any) {
      setErr(e?.message || "Upload failed");
    } finally {
      setUploadingSlot(null);
    }
  }

  async function archivePhoto(attId: number) {
    if (!(await dialog.confirm({ message: "Remove this photo?", danger: true }))) return;
    try {
      await portalApi.post(`/api/supplier-portal/attachments/${attId}/archive`, token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to remove");
    }
  }

  if (loading) {
    return (
      <PortalFrame>
        <SupplierCaseSkeleton />
      </PortalFrame>
    );
  }
  if (err && !data) {
    return (
      <PortalFrame>
        <div className="mx-auto max-w-4xl px-4 py-8 text-center">
          <div className="mb-2 text-[15px] font-semibold text-err">Unavailable</div>
          <div className="mb-4 text-[13px] text-ink-secondary">{err}</div>
          <Button variant="secondary" onClick={() => load()}>
            Reload
          </Button>
        </div>
      </PortalFrame>
    );
  }
  if (!data) return null;

  const cs = data.case;
  const stageLabel = STAGE_LABEL[cs.stage] || cs.stage;

  return (
    <PortalFrame>
      <main className="mx-auto max-w-4xl px-4 py-6 print:max-w-none print:p-0">
        {/* Title */}
        <div className="border-2 border-ink bg-surface text-center">
          <h1 className="py-3 text-[18px] font-bold tracking-wide text-ink">
            SUPPLIER SERVICE REQUEST
          </h1>
        </div>

        {/* Top metadata strip */}
        <FormRow>
          <FormCell label="ASSR NO" value={cs.assr_no} bold />
          <FormCell label="Request Date" value={fmtDate(cs.complained_date)} />
          <FormCell label="Category" value={cs.issue_category || cs.service_category || "—"} />
        </FormRow>
        <FormRow>
          <FormCell label="Ref No" value={cs.ref_no || "—"} />
          <FormCell label="PO No" value={cs.po_no || "—"} />
          <FormCell label="Service Category" value={cs.service_category || "—"} />
        </FormRow>

        {/* Supplier Info */}
        <SectionHeader>Supplier Info</SectionHeader>
        <FormRow>
          <FormCell label="Supplier Name" value={data.supplier_name || cs.creditor_code || "—"} />
          <FormCell label="Service Status" value={stageLabel} bold />
        </FormRow>

        {/* Problem Description */}
        <SectionHeader>Problem Description</SectionHeader>
        <div className="border border-ink/40 bg-surface px-3 py-2 text-[12px] text-ink">
          {cs.complaint_issue || "—"}
        </div>

        {/* Items */}
        <ItemsTable items={data.items} />

        {/* Service Issue + Operation QC Checked pictures */}
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <PictureBlock
            title="Service Issue (Attach Reference Picture)"
            category="evidence"
            token={token}
            attachments={data.attachments.filter((a) => a.category === "evidence")}
            uploading={uploadingSlot === "evidence"}
            onUpload={(f) => uploadPhoto(f, "evidence")}
            onArchive={archivePhoto}
          />
          <PictureBlock
            title="Operation QC Checked (Attach Reference Picture)"
            category="completion"
            token={token}
            attachments={data.attachments.filter((a) => a.category === "completion")}
            uploading={uploadingSlot === "completion"}
            onUpload={(f) => uploadPhoto(f, "completion")}
            onArchive={archivePhoto}
          />
        </div>

        {/* Proof of Service */}
        <SectionHeader>Proof of Service</SectionHeader>
        <FormRow>
          <FormCell label="Supplier Pickup Date" value={fmtDate(cs.supplier_pickup_at)} />
          <FormCell label="Supplier Ready Date" value={fmtDate(cs.items_ready_at)} />
        </FormRow>
        <FormRow>
          <FormCell label="Proof of Pickup Date" value={<SigPlaceholder />} />
          <FormCell label="Proof of Return Date" value={<SigPlaceholder />} />
        </FormRow>

        {/* Supplier Remarks + Warehouse Ack */}
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="border border-ink/40 bg-surface">
            <div className="border-b border-ink/40 bg-bg/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink">
              Supplier Remarks
            </div>
            <textarea
              aria-label="Supplier remarks"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              rows={4}
              placeholder="Add a remark — sent to Houzs Operations on submit."
              className="w-full resize-none border-0 bg-transparent px-3 py-2 text-[12px] outline-none"
              maxLength={2000}
            />
            <div className="flex items-center justify-between border-t border-ink/40 px-3 py-1.5 text-[10px] text-ink-muted">
              <span aria-live="polite">{remark.length}/2000</span>
              <Button
                variant="primary"
                onClick={postRemark}
                disabled={!remark.trim() || savingRemark}
                className="h-8 px-3 text-[11px]"
              >
                {savingRemark ? "Sending…" : "Send remark"}
              </Button>
            </div>
          </div>
          <div className="border border-ink/40 bg-surface">
            <div className="border-b border-ink/40 bg-bg/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink">
              Warehouse Acknowledgement
            </div>
            <div className="space-y-1.5 px-3 py-2 text-[12px]">
              <div>Warehouse Verified & Acknowledged:</div>
              <div className="text-ink-muted">Name :</div>
              <div className="text-ink-muted">Date Received :</div>
            </div>
          </div>
        </div>

        {/* Stage update buttons */}
        <div className="mt-4 rounded border border-accent/40 bg-accent/5 p-3 print:hidden">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-accent">
            Update job status
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {ALLOWED_STAGE_ACTIONS.map((s) => (
              <Button
                key={s.value}
                variant="primary"
                onClick={() => moveStage(s.value)}
                disabled={submittingStage !== null || cs.stage === s.value}
                className="min-h-[44px]"
                aria-label={s.label}
              >
                {submittingStage === s.value ? "Updating…" : s.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-ink-muted">
            Houzs Operations is notified on every status change.
          </p>
        </div>

        {/* Footer actions */}
        <div className="mt-5 flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center sm:gap-3 print:hidden">
          <Button variant="primary" onClick={() => window.print()} icon={<Printer size={14} />}>
            Print Supplier Template
          </Button>
          <Button variant="secondary" onClick={() => nav(-1)} icon={<ArrowLeft size={14} />}>
            Back
          </Button>
        </div>

        {err && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[11px] text-err print:hidden">
            <span>{err}</span>
            <Button variant="ghost" onClick={() => load()} className="h-7 px-2 text-[11px]">
              Reload
            </Button>
          </div>
        )}
      </main>
    </PortalFrame>
  );
}

// ── Building blocks (Lim-style paper-form cells) ───────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 border-2 border-ink bg-ink text-surface">
      <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider">
        {children}
      </div>
    </div>
  );
}

function FormRow({ children }: { children: React.ReactNode }) {
  // Border-collapse-like: each FormRow joins its cells edge-to-edge,
  // and adjacent rows share the same outer border for the paper look.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 -mt-px first:mt-0">
      {children}
    </div>
  );
}

function FormCell({
  label,
  value,
  bold,
}: {
  label: string;
  value: React.ReactNode;
  bold?: boolean;
}) {
  return (
    <div className="-ml-px flex items-stretch border border-ink/40 first:ml-0">
      <div className="w-32 shrink-0 border-r border-ink/40 bg-bg/60 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink">
        {label}
      </div>
      <div className={`flex-1 px-3 py-1.5 text-[12px] ${bold ? "font-semibold text-ink" : "text-ink"}`}>
        {value || "—"}
      </div>
    </div>
  );
}

function ItemsTable({
  items,
}: {
  items: SupplierCase["items"];
}) {
  // Lim's form fixes the table at 5 rows — preserve that for parity.
  const filledRows = items.slice(0, 5);
  const emptyRows = Math.max(0, 5 - filledRows.length);
  return (
    <div className="mt-3 border border-ink/40">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="bg-ink text-surface">
            <th className="border-r border-ink/40 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider" style={{ width: 40 }}>
              NO
            </th>
            <th className="border-r border-ink/40 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider">
              ITEM
            </th>
            <th className="border-r border-ink/40 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider" style={{ width: 60 }}>
              QTY
            </th>
            <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider">
              REMARK (IF ANY)
            </th>
          </tr>
        </thead>
        <tbody>
          {filledRows.map((i, idx) => (
            <tr key={i.id} className="border-t border-ink/40">
              <td className="border-r border-ink/40 px-2 py-1 align-top">{idx + 1}</td>
              <td className="border-r border-ink/40 px-2 py-1 align-top">
                {i.item_description ? `${i.item_description}` : ""}
                {i.item_code && (
                  <span className="ml-1 text-ink-muted">({i.item_code})</span>
                )}
              </td>
              <td className="border-r border-ink/40 px-2 py-1 align-top">{i.qty ?? 1}</td>
              <td className="px-2 py-1 align-top text-ink-muted"></td>
            </tr>
          ))}
          {Array.from({ length: emptyRows }).map((_, idx) => (
            <tr key={`empty-${idx}`} className="border-t border-ink/40">
              <td className="border-r border-ink/40 px-2 py-1 align-top text-ink-muted">
                {filledRows.length + idx + 1}
              </td>
              <td className="border-r border-ink/40 px-2 py-1">&nbsp;</td>
              <td className="border-r border-ink/40 px-2 py-1">&nbsp;</td>
              <td className="px-2 py-1">&nbsp;</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PictureBlock({
  title,
  category,
  token,
  attachments,
  uploading,
  onUpload,
  onArchive,
}: {
  title: string;
  category: "evidence" | "completion";
  token: string;
  attachments: SupplierCase["attachments"];
  uploading: boolean;
  onUpload: (f: File) => void;
  onArchive: (attId: number) => void;
}) {
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) onUpload(f);
  }

  return (
    <div className="border border-ink/40 bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-ink/40 bg-bg/60 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink">{title}</span>
        <label
          className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink hover:border-accent/40 print:hidden ${
            uploading ? "pointer-events-none opacity-50" : ""
          }`}
          aria-label={`Attach photo for ${title}`}
        >
          <Upload size={11} /> {uploading ? "Uploading…" : "Attach"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            onChange={onFile}
            disabled={uploading}
          />
        </label>
      </div>
      {attachments.length === 0 ? (
        <div className="flex h-20 items-center justify-center text-[11px] text-ink-muted/70 sm:h-32">
          No photo yet
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-3">
          {attachments.map((a) => (
            <SupplierPhoto
              key={a.id}
              token={token}
              attId={a.id}
              label={category === "evidence" ? "Service issue" : "QC checked"}
              onRemove={() => onArchive(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SupplierPhoto({
  token,
  attId,
  label,
  onRemove,
}: {
  token: string;
  attId: number;
  label: string;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let localUrl: string | null = null;
    portalApi
      .fetchBlobUrl(`/api/supplier-portal/attachments/${attId}`, token)
      .then((u) => {
        if (revoked) {
          URL.revokeObjectURL(u);
        } else {
          localUrl = u;
          setUrl(u);
        }
      })
      .catch(() => {});
    return () => {
      revoked = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [attId, token]);

  return (
    <div className="group relative">
      <div className="block w-full overflow-hidden rounded-md border border-border bg-bg">
        {url ? (
          <img src={url} alt={label} className="h-20 w-full object-cover sm:h-24" />
        ) : (
          <div className="h-20 w-full animate-pulse bg-ink-muted/10 sm:h-24" />
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 rounded-full bg-ink/75 p-1 text-white opacity-0 transition-opacity hover:bg-err focus:opacity-100 group-hover:opacity-100 print:hidden"
        title="Remove this photo"
        aria-label="Remove this photo"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

function SupplierCaseSkeleton() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <Skeleton className="h-10 w-full" />
      <div className="mt-3 space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <div className="mt-4">
        <Skeleton className="h-40 w-full" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    </main>
  );
}

function SigPlaceholder() {
  return <span className="text-[11px] italic text-ink-muted/70">WH signature</span>;
}
