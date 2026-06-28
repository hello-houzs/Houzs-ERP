// ----------------------------------------------------------------------------
// Categories — lightweight catalogue-category management at /scm/categories.
//
// Hosts the HeroImageEditor so the category covers (the hero photos shown on
// front-of-house pages) can be uploaded + focal-point set + alt-text written
// without needing a full categories CRUD page. The list is read-only here;
// rows open a side drawer with the editor.
//
// Wires to:
//   GET /scm/categories → { categories: CategoryRow[] }
// Until the list endpoint ships, the "Not yet wired · Setup notes" treatment
// is rendered so the page stays loadable.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, FolderTree, Image as ImageIcon, RotateCw, X } from "lucide-react";
import { Button } from "../../components/Button";
import { HeroImageEditor } from "../../components/scm-v2/HeroImageEditor";
import { classifyLoadError, errMsg } from "../../components/scm-v2/PhotoGallery";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { cn } from "../../lib/utils";

type CategoryRow = {
  id: string;
  name: string;
  slug?: string | null;
  hero_image_key?: string | null;
  hero_url?: string | null;
};

export function Categories() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const editId = searchParams.get("edit");

  const catsQ = useQuery({
    queryKey: ["scm-categories"],
    queryFn: () =>
      authedFetch<{ categories: CategoryRow[] }>(`/categories`).then((r) =>
        r.categories.sort((a, b) => a.name.localeCompare(b.name)),
      ),
    retry: false,
    staleTime: 60_000,
  });

  const loadStatus = catsQ.error ? classifyLoadError(catsQ.error) : "ok";
  const cats = catsQ.data ?? [];
  const editing = editId ? cats.find((c) => c.id === editId) ?? null : null;

  const openEditor = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set("edit", id);
    setSearchParams(sp, { replace: true });
  };
  const closeEditor = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete("edit");
    setSearchParams(sp, { replace: true });
  };

  // Esc closes the drawer
  useEffect(() => {
    if (!editId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEditor();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  return (
    <div className="mx-auto max-w-[1280px] space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate("/scm/products")}
            className="mb-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted hover:text-primary"
          >
            <ArrowLeft size={12} /> Products
          </button>
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
            <FolderTree size={11} /> SCM · Catalogue · Categories
          </div>
          <h1 className="mt-1 font-display text-[21px] font-extrabold tracking-tight text-ink">
            Categories
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Catalogue categories. Each one carries a cover image (hero) shown on
            the front-of-house catalogue. Click a row to upload / replace the
            cover and set its focal point.
          </p>
        </div>
      </div>

      {/* Loading */}
      {catsQ.isLoading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-32 rounded-xl" />
          ))}
        </div>
      )}

      {/* Not configured / error */}
      {loadStatus === "not-configured" && !catsQ.isLoading && (
        <div className="rounded-lg border border-border bg-surface-2 px-5 py-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
            <FolderTree size={20} />
          </div>
          <div className="mt-3 text-[14px] font-bold text-ink">
            Categories endpoint not yet live
          </div>
          <p className="mx-auto mt-1.5 max-w-[440px] text-[12px] leading-relaxed text-ink-muted">
            The catalogue-categories list endpoint isn't registered yet. The
            hero-image POST/GET/DELETE handlers exist, they just don't have
            a list to drive the UI. Track at{" "}
            <span className="font-money">BACKEND-CHECKLIST · A2</span>.
          </p>
          <div className="mt-4">
            <Button
              variant="secondary"
              icon={<RotateCw size={14} />}
              onClick={() => catsQ.refetch()}
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      {loadStatus === "error" && !catsQ.isLoading && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Couldn't load categories: {errMsg(catsQ.error)}
        </div>
      )}

      {/* Empty (no categories registered) */}
      {loadStatus === "ok" && !catsQ.isLoading && cats.length === 0 && (
        <div className="rounded-md border border-border bg-surface-2 px-4 py-6 text-center text-[12px] text-ink-muted">
          No categories registered yet.
        </div>
      )}

      {/* Grid */}
      {loadStatus === "ok" && cats.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cats.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => openEditor(c.id)}
              className="group relative overflow-hidden rounded-xl border border-border bg-surface text-left shadow-stone transition-all hover:-translate-y-px hover:border-primary/40"
            >
              <div
                className="relative aspect-[16/7] w-full bg-surface-2"
                style={{
                  backgroundImage: c.hero_url ? `url(${c.hero_url})` : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                {!c.hero_url && (
                  <div className="absolute inset-0 flex items-center justify-center text-ink-muted">
                    <ImageIcon size={28} className="opacity-60" />
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate font-display text-[14px] font-bold text-ink">
                    {c.name}
                  </div>
                  {c.slug && (
                    <div className="truncate font-money text-[10.5px] text-ink-muted">
                      {c.slug}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-[11px] font-semibold text-primary group-hover:text-primary-ink">
                  Edit hero →
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Side drawer */}
      {editing && (
        <Drawer onClose={closeEditor} title={editing.name}>
          <HeroImageEditor
            categoryId={editing.id}
            categoryName={editing.name}
            onClose={closeEditor}
          />
        </Drawer>
      )}
    </div>
  );
}

function Drawer({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-ink/40"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit hero for ${title}`}
      onClick={onClose}
    >
      <div
        className={cn(
          "ml-auto h-full w-full max-w-[640px] overflow-y-auto bg-surface shadow-slab",
          // slide-in on desktop; full screen on small
          "animate-[rise_220ms_cubic-bezier(0.16,1,0.3,1)_both]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border bg-surface px-5 py-3">
          <div className="font-display text-[14px] font-extrabold text-ink">
            Edit hero · {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-muted hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
