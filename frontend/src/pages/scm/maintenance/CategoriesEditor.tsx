// ----------------------------------------------------------------------------
// CategoriesEditor — Maintenance tab body for product-category hero images.
//
// API — backend/src/scm/routes/categories.ts, mounted /api/scm/admin/categories:
//   POST   /:id/hero-image   raw image body (image/jpeg | image/png, <= 4MB)
//                            -> { ok: true, key }   (admin / coordinator only)
//   DELETE /:id/hero-image   -> { ok: true }        (admin / coordinator only)
//
// EDIT-ONLY ROUTE: this API exposes ONLY hero-image upload + clear, both keyed
// by a category id. There is NO list/GET, no create, edit, or delete of the
// category rows themselves on this route — the `categories` table is read
// elsewhere (the POS catalogue), and category names/enum live with mfg_products.
// So this tab is a targeted hero-image manager: supply a category id, then
// upload or clear its hero image. No browseable category list is available here.
//
// No money. No naked edits — clearing the image routes through useDialog().confirm.
// Upload uses api.putBinary (raw image bytes, not JSON). The R2 PUBLIC_ASSETS
// bucket must be provisioned for upload to succeed (see the route's TODO note).
// ----------------------------------------------------------------------------

import { useRef, useState } from "react";
import { Upload, Trash2 } from "lucide-react";
import { Button } from "../../../components/Button";
import { useToast } from "../../../hooks/useToast";
import { useDialog } from "../../../hooks/useDialog";
import { api } from "../../../api/client";
import { SCM } from "../../../lib/scm";
import { Field, Input } from "../Suppliers";

const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png"];

export function CategoriesEditor() {
  const toast = useToast();
  const dialog = useDialog();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);

  function pickFile() {
    if (!categoryId.trim()) {
      toast.error("Enter a category id first");
      return;
    }
    fileRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const id = categoryId.trim();
    if (!id) {
      toast.error("Enter a category id first");
      return;
    }
    if (!ACCEPTED.includes(file.type)) {
      toast.error("Hero image must be a JPEG or PNG");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Hero image must be 4MB or smaller");
      return;
    }
    setBusy(true);
    try {
      await api.putBinary(`${SCM}/admin/categories/${encodeURIComponent(id)}/hero-image`, await file.arrayBuffer(), file.type);
      toast.success("Hero image uploaded");
    } catch (err) {
      const msg = String((err as Error)?.message ?? "");
      if (msg.includes("403") || msg.includes("forbidden")) {
        toast.error("You don't have permission to manage category images");
      } else if (msg.includes("PUBLIC_ASSETS") || msg.includes("500")) {
        toast.error("Image storage isn't provisioned yet (R2 PUBLIC_ASSETS bucket)");
      } else {
        toast.error("Failed to upload hero image");
      }
    } finally {
      setBusy(false);
    }
  }

  async function clearImage() {
    const id = categoryId.trim();
    if (!id) {
      toast.error("Enter a category id first");
      return;
    }
    const ok = await dialog.confirm({
      title: "Clear hero image",
      message: "Remove this category's hero image? The category keeps its other data.",
      danger: true,
      confirmLabel: "Clear",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`${SCM}/admin/categories/${encodeURIComponent(id)}/hero-image`);
      toast.success("Hero image cleared");
    } catch (err) {
      const msg = String((err as Error)?.message ?? "");
      toast.error(msg.includes("403") || msg.includes("forbidden") ? "You don't have permission to manage category images" : "Failed to clear hero image");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-warning-text/30 bg-warning-bg/40 p-3 text-[12px] text-ink-secondary">
        <strong className="text-ink">Hero images only.</strong> The categories admin API exposes just hero-image
        upload and clear, keyed by category id — there's no list, create, or edit of the categories themselves here.
        Supply a category id, then upload a JPEG/PNG (4MB max) or clear the existing image.
      </div>

      <div className="max-w-lg space-y-3 rounded-lg border border-border bg-surface p-4 shadow-stone">
        <Field label="Category ID" required>
          <Input value={categoryId} onChange={setCategoryId} placeholder="categories.id" />
        </Field>

        <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={onFile} />

        <div className="flex items-center gap-2 pt-1">
          <Button icon={<Upload size={15} />} onClick={pickFile} disabled={busy}>
            {busy ? "Working…" : "Upload Hero Image"}
          </Button>
          <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => void clearImage()} disabled={busy}>
            Clear Image
          </Button>
        </div>

        <p className="text-[11px] text-ink-muted">JPEG or PNG, 4MB max. Admin / coordinator roles only.</p>
      </div>
    </div>
  );
}
