// ----------------------------------------------------------------------------
// SoLineCard — the SO line-item configurator, ported from 2990's
// SoLineCard.tsx (structure/fields/behaviour) and rebuilt in Houzs Tailwind
// primitives. NO 2990 CSS modules / design-system.
//
// Layout (single header row):
//   [#] [Item picker] [Remark] [Qty] [Unit Price] [Delivery Date] [Amount] [badge] [trash]
//
// Below the row, per-category variant UI (only when a SKU is picked):
//   SOFA     → Fabrics / Seat Heights / Leg Heights + Specials accordion
//   BEDFRAME → Fabrics / Gaps / Divan Heights / Leg Heights (+ auto Total
//              Height = divan+leg+gap) + Specials accordion
//   MATTRESS → Specials accordion only (when the Model offers any)
//   ACCESSORY / OTHERS → no variant UI
//
// Pricing is SERVER-SIDE: the operator types the unit price (RM→sen); the
// server recompute is authoritative at save and stamps description2 + price
// columns. No client price math here.
//
// Pool sources are fetched ONCE by the parent and passed in as props:
//   - maint: GET /maintenance-config/resolved?scope=master  (height/size/gap pools)
//   - specialDefs: GET /special-addons                      (specials)
//   - fabricOptions: GET /fabric-tracking + fabric series   (fabric colour picker)
// Each card filters those pools by the SKU's allowed_options (see helpers).
//
// camelCase trap: the /api/scm reads come back snake_case from the Supabase
// client (mfg-products → code/name/sell_price_sen/allowed_options/...;
// fabric-tracking → fabric_code/supplier_code). special-addons IS camelCased
// (server toApi). We DUAL-READ r.camelCase ?? r.snake_case everywhere a copied
// 2990 field could differ.
// ----------------------------------------------------------------------------

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ImagePlus, X } from "lucide-react";
import { useQuery } from "../../hooks/useQuery";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { LineCard, LineField, lineInputCls, LineTotalRow } from "./_lineKit";

// Per-line photo staging — mirrors the server's POST /…/photos guard so a
// staged file that the endpoint would reject is caught before the SO is even
// created. 10 MB / image-only matches mfg-sales-orders.ts MAX_PHOTO_BYTES.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
import {
  activeOptions,
  maintPickerValues,
  type SoLineDraft,
  type ResolvedMaintConfig,
  type AllowedOptions,
} from "./mfgSalesOrderShared";

// ── Picker response shapes (mostly snake_case from the Supabase client) ──────
// GET /api/scm/mfg-products?search= — full SKU catalogue.
export interface MfgProductRow {
  id: string;
  code: string;
  name: string;
  category: string;
  sell_price_sen?: number | null;
  base_price_sen?: number | null;
  price1_sen?: number | null;
  seat_height_prices?: unknown;
  allowed_options?: AllowedOptions | null;
  // Defensive camelCase aliases (in case a future route camelCases).
  sellPriceSen?: number | null;
  allowedOptions?: AllowedOptions | null;
}

// GET /api/scm/special-addons — camelCased by the server's toApi().
export interface SpecialAddonChoice {
  label: string;
  extraSen: number;
}
export interface SpecialAddonGroup {
  label: string;
  required: boolean;
  choices: SpecialAddonChoice[];
}
export interface SpecialAddonRow {
  id: string;
  code: string;
  label: string;
  soDescription: string;
  categories: string[];
  sellingPriceSen: number;
  optionGroups: SpecialAddonGroup[];
  active: boolean;
  // Defensive snake_case aliases.
  selling_price_sen?: number;
  option_groups?: SpecialAddonGroup[];
}

// GET /api/scm/fabric-tracking — snake_case from the Supabase client.
export interface FabricTrackingRow {
  id: string;
  fabric_code: string;
  fabric_description?: string | null;
  supplier_code?: string | null;
  series?: string | null;
  is_active?: boolean | null;
  // Defensive camelCase aliases.
  fabricCode?: string;
  supplierCode?: string | null;
}

// A normalised fabric option the picker renders.
export interface FabricOption {
  value: string; // the colour / fabric code stored on the line
  display: string;
}

const TODAY = new Date().toISOString().slice(0, 10);

// Per-category badge — colour swatch + short label.
const CATEGORY_BADGE: Record<string, { label: string; cls: string }> = {
  sofa: { label: "Sofa", cls: "bg-accent-soft text-accent" },
  bedframe: { label: "Bedframe", cls: "bg-synced/15 text-synced" },
  mattress: { label: "Mattress", cls: "bg-warning-bg text-warning-text" },
  accessory: { label: "Accessory", cls: "bg-surface-dim text-ink-secondary" },
  others: { label: "Other", cls: "bg-surface-dim text-ink-muted" },
  service: { label: "Service", cls: "bg-surface-dim text-ink-muted" },
};

function specialsList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string" && v) return [v];
  return [];
}

function parseInches(s: unknown): number {
  if (s === null || s === undefined) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
}

// allowed_options inversion helpers ──────────────────────────────────────────
// HEIGHT/SIZE/GAP pools: a non-empty allow-list FILTERS; empty/absent =
// unrestricted (offer all). SPECIALS: empty = nothing-offered (Modular ON/OFF).
function restrictPriced<T extends { value: string }>(
  opts: T[],
  pool?: string[] | null,
): T[] {
  return Array.isArray(pool) && pool.length > 0
    ? opts.filter((o) => pool.includes(o.value))
    : opts;
}
function restrictStrings(opts: string[], pool?: string[] | null): string[] {
  return Array.isArray(pool) && pool.length > 0
    ? opts.filter((o) => pool.includes(o))
    : opts;
}

export interface SoLineCardProps {
  index: number;
  draft: SoLineDraft;
  onChange: (patch: Partial<SoLineDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
  // Shared pools (fetched once by the parent).
  maint: ResolvedMaintConfig | null;
  specialDefs: SpecialAddonRow[];
  fabricOptions: FabricOption[];
  // Master-follower cascade: the variants from the FIRST line of each category
  // (keyed by lowercase itemGroup). A follower line seeds these on product pick
  // so a new same-category line inherits the master's fabric/heights/specials.
  inheritVariantsByCategory?: Record<string, Record<string, unknown> | undefined>;
}

function SoLineCardInner({
  index,
  draft,
  onChange,
  onRemove,
  canRemove,
  maint,
  specialDefs,
  fabricOptions,
  inheritVariantsByCategory,
}: SoLineCardProps) {
  const category = (draft.itemGroup || "others").toLowerCase();
  const badge = CATEGORY_BADGE[category] ?? CATEGORY_BADGE.others!;
  const dialog = useDialog();
  const toast = useToast();

  // ── Per-line photo staging ───────────────────────────────────────────────
  // Files live on the draft (stagedPhotos); they upload AFTER the SO is created
  // (see MfgSalesOrderNew). Object URLs are derived for preview and revoked on
  // change/unmount so we don't leak blobs.
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const stagedPhotos = draft.stagedPhotos ?? [];
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  useEffect(() => {
    const urls = stagedPhotos.map((f) => URL.createObjectURL(f));
    setPhotoUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedPhotos]);

  function onPickPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    if (picked.length === 0) return;
    const accepted: File[] = [];
    for (const f of picked) {
      if (!f.type || !f.type.toLowerCase().startsWith("image/")) {
        toast.error(`"${f.name}" isn't an image — skipped`);
        continue;
      }
      if (f.size > MAX_PHOTO_BYTES) {
        toast.error(`"${f.name}" is over 10MB — skipped`);
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length === 0) return;
    onChange({ stagedPhotos: [...stagedPhotos, ...accepted] });
  }

  async function removePhoto(idx: number) {
    const ok = await dialog.confirm({
      title: "Remove photo",
      message: "Remove this staged photo from the line? It hasn't been uploaded yet.",
      danger: true,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    onChange({ stagedPhotos: stagedPhotos.filter((_, i) => i !== idx) });
  }

  // ── SKU picker (search-as-you-type) ─────────────────────────────────────
  const [search, setSearch] = useState(draft.description || draft.itemCode || "");
  const [showPicker, setShowPicker] = useState(false);
  const trimmed = search.trim();

  useEffect(() => {
    setSearch(draft.description || draft.itemCode || "");
  }, [draft.description, draft.itemCode]);

  // Only hit the catalogue once the picker is open + 2+ chars typed; otherwise
  // resolve empty so we never fire a request per keystroke / on closed pickers.
  const searchActive = showPicker && trimmed.length >= 2;
  const productsQ = useQuery<{ products: MfgProductRow[] }>(
    () =>
      searchActive
        ? api.get(`${SCM}/mfg-products?search=${encodeURIComponent(trimmed)}`)
        : Promise.resolve({ products: [] }),
    [searchActive ? trimmed : ""],
  );
  const candidates = searchActive ? productsQ.data?.products ?? [] : [];

  // The picked product's allowed_options — needed to filter the pools. We read
  // it from the candidate list (fresh pick) and stash it so it survives the
  // picker closing. DUAL-READ camelCase ?? snake_case.
  const [pickedAllowed, setPickedAllowed] = useState<AllowedOptions | null>(null);
  const [pickedSeatPrices, setPickedSeatPrices] = useState<unknown>(null);

  function pickProduct(p: MfgProductRow) {
    const cat = (p.category || "others").toLowerCase();
    const sellSen = p.sellPriceSen ?? p.sell_price_sen ?? 0;
    setPickedAllowed(p.allowedOptions ?? p.allowed_options ?? null);
    setPickedSeatPrices(p.seat_height_prices ?? null);
    // Master-follower inherit: a same-category follower line seeds the master's
    // variants on pick. Fresh pick otherwise resets the build so a previous
    // category's variants don't leak. overriddenKeys resets to [] so the
    // cascade can keep this line in sync until the operator edits a key.
    const inherited = inheritVariantsByCategory?.[cat];
    const seedVariants =
      inherited && Object.keys(inherited).length > 0 ? { ...inherited } : {};
    onChange({
      itemCode: p.code,
      itemGroup: cat,
      description: p.name,
      unitPriceCenti: sellSen ?? 0,
      variants: seedVariants,
      overriddenKeys: [],
    });
    setSearch(p.name);
    setShowPicker(false);
  }

  const allowOpts = pickedAllowed;

  // ── Money text fields (RM strings, integer sen on the draft) ─────────────
  const [priceText, setPriceText] = useState((draft.unitPriceCenti / 100).toFixed(2));
  useEffect(() => {
    const parsed = Math.round(Number(priceText) * 100) || 0;
    if (parsed !== draft.unitPriceCenti) {
      setPriceText((draft.unitPriceCenti / 100).toFixed(2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.unitPriceCenti]);

  const [discountText, setDiscountText] = useState(
    draft.discountCenti ? (draft.discountCenti / 100).toFixed(2) : "",
  );

  // ── Variant writers ──────────────────────────────────────────────────────
  // A manual variant edit records the touched keys in overriddenKeys so the
  // master-follower cascade leaves this line alone for those keys (the
  // follower's own pick wins). A fabric pick lands several keys atomically, so
  // all of them are marked overridden in one patch.
  function setVariants(patch: Record<string, unknown>) {
    const nextOverrides = Array.from(
      new Set([...(draft.overriddenKeys ?? []), ...Object.keys(patch)]),
    );
    onChange({
      variants: { ...draft.variants, ...patch },
      overriddenKeys: nextOverrides,
    });
  }
  function setVariant(k: string, v: string | string[]) {
    setVariants({ [k]: v });
  }

  // One fabric pick lands fabricCode + colourId + labels in one patch (mirrors
  // the POS handover payload's buildVariants).
  function pickFabric(value: string) {
    const opt = fabricOptions.find((o) => o.value === value);
    setVariants({
      fabricCode: value,
      colourId: value,
      ...(opt ? { fabricLabel: opt.display } : {}),
    });
  }

  // ── Bedframe auto Total Height = Divan + Leg + Gap ───────────────────────
  const computedTotalHeight = useMemo(() => {
    if (category !== "bedframe") return "";
    const d = parseInches(draft.variants.divanHeight);
    const l = parseInches(draft.variants.legHeight);
    const g = parseInches(draft.variants.gap);
    if (d === 0 && l === 0 && g === 0) return "";
    return `${d + l + g}"`;
  }, [
    category,
    draft.variants.divanHeight,
    draft.variants.legHeight,
    draft.variants.gap,
  ]);

  useEffect(() => {
    if (category !== "bedframe" || !computedTotalHeight) return;
    if (String(draft.variants.totalHeight ?? "") === computedTotalHeight) return;
    setVariants({ totalHeight: computedTotalHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedTotalHeight, category]);

  // ── Specials (per-category ∩ Model allowed_options.specials) ─────────────
  const catUpper = category.toUpperCase();
  const specialOptions = useMemo(() => {
    // SPECIALS inversion: empty allow-list = nothing offered (NOT unrestricted).
    const allowed = new Set(allowOpts?.specials ?? []);
    return specialDefs.filter(
      (a) => a.active && a.categories.includes(catUpper) && allowed.has(a.code),
    );
  }, [specialDefs, catUpper, allowOpts]);

  const pickedSpecials = specialsList(draft.variants.specials);
  const specialChoicesMap: Record<string, string[]> =
    draft.variants.specialChoices &&
    typeof draft.variants.specialChoices === "object"
      ? (draft.variants.specialChoices as Record<string, string[]>)
      : {};

  function toggleSpecial(code: string) {
    const has = pickedSpecials.includes(code);
    const nextPicked = has
      ? pickedSpecials.filter((c) => c !== code)
      : [...pickedSpecials, code];
    const nextChoices: Record<string, string[]> = { ...specialChoicesMap };
    if (has) {
      delete nextChoices[code];
    } else {
      const def = specialDefs.find((d) => d.code === code);
      const groups = def?.optionGroups ?? def?.option_groups ?? [];
      if (groups.length > 0) {
        nextChoices[code] = groups.map((g) =>
          g.required && g.choices[0] ? g.choices[0].label : "",
        );
      }
    }
    setVariants({
      specials: nextPicked,
      specialChoices: nextChoices,
      specialLabels: nextPicked.map(
        (c) => specialDefs.find((d) => d.code === c)?.label ?? c,
      ),
    });
  }

  function changeSpecialChoice(code: string, groupIdx: number, label: string) {
    const def = specialDefs.find((d) => d.code === code);
    const groups = def?.optionGroups ?? def?.option_groups ?? [];
    const entry = [...(specialChoicesMap[code] ?? groups.map(() => ""))];
    entry[groupIdx] = label;
    setVariants({ specialChoices: { ...specialChoicesMap, [code]: entry } });
  }

  const [specialsOpen, setSpecialsOpen] = useState(false);

  // ── Derived render flags ─────────────────────────────────────────────────
  const lineTotal = Math.max(
    0,
    draft.qty * draft.unitPriceCenti - draft.discountCenti,
  );
  const hasVariantGrid = category === "sofa" || category === "bedframe";
  const hasMattressSpecials =
    category === "mattress" &&
    (specialOptions.length > 0 || pickedSpecials.length > 0);
  const showBody = Boolean(draft.itemCode) && (hasVariantGrid || hasMattressSpecials);

  // Seat-height selling surcharge lookup (display only; 0 today).
  function seatHeightSell(h: string): number {
    const arr = Array.isArray(pickedSeatPrices) ? pickedSeatPrices : [];
    const hit = (
      arr as Array<{ height: string; tier: string; sellingPriceSen?: number }>
    ).find((p) => p.height === h && p.tier === "PRICE_2");
    return hit?.sellingPriceSen ?? 0;
  }

  return (
    <LineCard
      index={index + 1}
      onRemove={onRemove}
      removeDisabled={!canRemove}
      removeTitle="Remove this line"
    >
      {/* Item — SKU picker (search-as-you-type) */}
      <LineField label="Item" required>
        <div className="relative">
          <input
            className={cn(lineInputCls, "font-mono")}
            placeholder="Click to pick or type to filter…"
            value={search}
            onFocus={() => setShowPicker(true)}
            onBlur={() => setTimeout(() => setShowPicker(false), 150)}
            onChange={(e) => {
              setSearch(e.target.value);
              setShowPicker(true);
            }}
          />
          {draft.itemCode && search === draft.description && (
            <span className="pointer-events-none absolute right-2 top-2 font-mono text-[10px] text-ink-muted">
              {draft.itemCode}
            </span>
          )}
          {showPicker && (
            <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-surface py-1 shadow-lg">
              {candidates.length > 0 ? (
                candidates.slice(0, 50).map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="block w-full px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-accent-soft"
                      onMouseDown={() => pickProduct(p)}
                    >
                      <span className="font-medium">{p.name}</span>
                      <span className="ml-2 font-mono text-[10px] text-ink-muted">
                        {p.code}
                      </span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="px-3 py-1.5 text-[12px] text-ink-muted">
                  {trimmed.length < 2
                    ? "Type at least 2 characters to search…"
                    : productsQ.loading
                      ? "Searching…"
                      : `No products match "${trimmed}".`}
                </li>
              )}
            </ul>
          )}
        </div>
      </LineField>

      {/* Remark */}
      <LineField label="Remark">
        <input
          className={lineInputCls}
          placeholder="Remark…"
          value={draft.remark}
          onChange={(e) => onChange({ remark: e.target.value })}
        />
      </LineField>

      {/* Qty / Unit Price / Delivery Date */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <LineField label="Qty" align="right" required>
          <input
            type="number"
            min={1}
            className={cn(lineInputCls, "text-right")}
            value={draft.qty === 0 ? "" : draft.qty}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ qty: v === "" ? 0 : parseInt(v) || 0 });
            }}
            onBlur={(e) => {
              if (!e.target.value || parseInt(e.target.value) <= 0)
                onChange({ qty: 1 });
            }}
            aria-label="Quantity"
          />
        </LineField>

        <LineField label="Unit Price (RM)" align="right" required>
          <input
            type="number"
            step="0.01"
            min={0}
            className={cn(lineInputCls, "text-right font-mono")}
            value={priceText}
            onChange={(e) => {
              const t = e.target.value;
              setPriceText(t);
              onChange({ unitPriceCenti: Math.round(Number(t) * 100) || 0 });
            }}
            onBlur={() => setPriceText((draft.unitPriceCenti / 100).toFixed(2))}
            placeholder="0.00"
            aria-label="Unit price"
          />
        </LineField>

        <LineField label="Delivery Date">
          <input
            type="date"
            className={lineInputCls}
            value={draft.lineDeliveryDate ?? ""}
            onChange={(e) =>
              onChange({
                lineDeliveryDate: e.target.value || null,
                lineDeliveryDateOverridden: true,
              })
            }
            aria-label="Line delivery date"
          />
        </LineField>
      </div>

      {/* Discount — only once a SKU is picked */}
      {draft.itemCode && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <LineField label="Discount (RM)" align="right">
            <input
              type="number"
              step="0.01"
              min={0}
              className={cn(lineInputCls, "text-right font-mono")}
              value={discountText}
              onChange={(e) => {
                const t = e.target.value;
                setDiscountText(t);
                onChange({ discountCenti: Math.round(Number(t) * 100) || 0 });
              }}
              placeholder="0.00"
              aria-label="Discount"
            />
          </LineField>
        </div>
      )}

      {/* Photos — staged; upload after SO create */}
      {draft.itemCode && (
        <LineField label="Photos">
          <div className="flex items-center gap-2">
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onPickPhotos}
            />
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-accent/50 px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent-soft"
            >
              <ImagePlus size={13} /> Add Photos
            </button>
            {stagedPhotos.length > 0 && (
              <span className="text-[11px] text-ink-muted">
                {stagedPhotos.length} staged · uploaded after the order is created
              </span>
            )}
          </div>
          {stagedPhotos.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {stagedPhotos.map((f, i) => (
                <div
                  key={`${f.name}-${f.size}-${i}`}
                  className="relative h-16 w-16 overflow-hidden rounded-md border border-border bg-surface-dim"
                >
                  {photoUrls[i] && (
                    <img
                      src={photoUrls[i]}
                      alt={f.name}
                      className="h-full w-full object-cover"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => void removePhoto(i)}
                    title="Remove photo"
                    aria-label="Remove photo"
                    className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink/60 text-white transition-colors hover:bg-err"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </LineField>
      )}

      {/* ── Variant body ─────────────────────────────────────────────────── */}
      {showBody && (
        <div className="border-t border-border-subtle pt-3">
          {hasVariantGrid && category === "bedframe" && maint && (
            <div className="space-y-3">
              <div className="text-[10px] font-bold uppercase tracking-brand text-ink-muted">
                Bedframe Variants
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <VariantSelect
                  label="Fabrics"
                  required
                  value={String(draft.variants.fabricCode ?? "")}
                  options={fabricOptions.map((o) => ({
                    value: o.value,
                    display: o.display,
                  }))}
                  onChange={pickFabric}
                />
                <VariantSelect
                  label="Gaps"
                  required
                  value={String(draft.variants.gap ?? "")}
                  options={restrictStrings(
                    maintPickerValues(maint.gaps, String(draft.variants.gap ?? "")),
                    allowOpts?.gaps,
                  ).map((g) => ({ value: g }))}
                  onChange={(v) => setVariant("gap", v)}
                />
                <VariantSelect
                  label="Divan Heights"
                  required
                  value={String(draft.variants.divanHeight ?? "")}
                  options={restrictPriced(
                    activeOptions(
                      maint.divanHeights,
                      String(draft.variants.divanHeight ?? ""),
                    ),
                    allowOpts?.divan_heights,
                  ).map((o) => ({ value: o.value, sellSen: o.sellingPriceSen ?? 0 }))}
                  onChange={(v) => setVariant("divanHeight", v)}
                />
                <VariantSelect
                  label="Leg Heights"
                  required
                  value={String(draft.variants.legHeight ?? "")}
                  options={restrictPriced(
                    activeOptions(
                      maint.legHeights,
                      String(draft.variants.legHeight ?? ""),
                    ),
                    allowOpts?.leg_heights,
                  ).map((o) => ({ value: o.value, sellSen: o.sellingPriceSen ?? 0 }))}
                  onChange={(v) => setVariant("legHeight", v)}
                />
              </div>
              {computedTotalHeight && (
                <div className="text-[11px] text-ink-muted">
                  Total height (auto):{" "}
                  <strong className="font-mono text-ink">
                    {computedTotalHeight}
                  </strong>{" "}
                  (Divan + Leg + Gap)
                </div>
              )}
              <SpecialsAccordion
                open={specialsOpen}
                onToggle={() => setSpecialsOpen((o) => !o)}
                picked={pickedSpecials}
                choices={specialChoicesMap}
                options={specialOptions}
                onToggleCode={toggleSpecial}
                onChoice={changeSpecialChoice}
              />
            </div>
          )}

          {hasVariantGrid && category === "sofa" && maint && (
            <div className="space-y-3">
              <div className="text-[10px] font-bold uppercase tracking-brand text-ink-muted">
                Sofa Variants
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <VariantSelect
                  label="Fabrics"
                  required
                  value={String(draft.variants.fabricCode ?? "")}
                  options={fabricOptions.map((o) => ({
                    value: o.value,
                    display: o.display,
                  }))}
                  onChange={pickFabric}
                />
                <VariantSelect
                  label="Seat Heights"
                  required
                  value={String(draft.variants.seatHeight ?? "")}
                  options={restrictStrings(
                    maintPickerValues(
                      maint.sofaSizes,
                      String(draft.variants.seatHeight ?? ""),
                    ),
                    allowOpts?.sizes,
                  ).map((s) => ({ value: s, sellSen: seatHeightSell(s) }))}
                  onChange={(v) => setVariant("seatHeight", v)}
                />
                <VariantSelect
                  label="Leg Heights"
                  required
                  value={String(draft.variants.legHeight ?? "")}
                  options={restrictPriced(
                    activeOptions(
                      maint.sofaLegHeights,
                      String(draft.variants.legHeight ?? ""),
                    ),
                    allowOpts?.leg_heights,
                  ).map((o) => ({ value: o.value, sellSen: o.sellingPriceSen ?? 0 }))}
                  onChange={(v) => setVariant("legHeight", v)}
                />
              </div>
              <SpecialsAccordion
                open={specialsOpen}
                onToggle={() => setSpecialsOpen((o) => !o)}
                picked={pickedSpecials}
                choices={specialChoicesMap}
                options={specialOptions}
                onToggleCode={toggleSpecial}
                onChoice={changeSpecialChoice}
              />
            </div>
          )}

          {hasMattressSpecials && (
            <div className="space-y-3">
              <div className="text-[10px] font-bold uppercase tracking-brand text-ink-muted">
                Mattress Add-ons
              </div>
              <SpecialsAccordion
                open={specialsOpen}
                onToggle={() => setSpecialsOpen((o) => !o)}
                picked={pickedSpecials}
                choices={specialChoicesMap}
                options={specialOptions}
                onToggleCode={toggleSpecial}
                onChoice={changeSpecialChoice}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Line total + category pill ───────────────────────────────────── */}
      <LineTotalRow>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-brand",
            badge.cls,
          )}
        >
          {badge.label}
        </span>
        <span className="font-mono text-[13px] font-semibold text-ink">
          {fmtCenti(lineTotal)}
        </span>
      </LineTotalRow>
    </LineCard>
  );
}

export const SoLineCard = memo(SoLineCardInner);

// ── VariantSelect — labelled <select> with optional "+RM" selling suffix ─────
interface VariantSelectOption {
  value: string;
  display?: string;
  sellSen?: number;
}
function VariantSelect({
  label,
  options,
  value,
  onChange,
  required = false,
}: {
  label: string;
  options: VariantSelectOption[];
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  const invalid = required && !value;
  const hasCurrent = Boolean(value) && options.some((o) => o.value === value);
  return (
    <LineField label={label} required={required}>
      <select
        className={cn(lineInputCls, invalid && "border-err")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          Select…
        </option>
        {value && !hasCurrent && (
          <option value={value}>{value} (current)</option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.display ?? o.value}
            {o.sellSen && o.sellSen > 0 ? ` (+${fmtCenti(o.sellSen)})` : ""}
          </option>
        ))}
      </select>
    </LineField>
  );
}

// ── SpecialsAccordion — collapsible checkbox grid + follow-up choice pickers ──
function SpecialsAccordion({
  open,
  onToggle,
  picked,
  choices,
  options,
  onToggleCode,
  onChoice,
}: {
  open: boolean;
  onToggle: () => void;
  picked: string[];
  choices: Record<string, string[]>;
  options: SpecialAddonRow[];
  onToggleCode: (code: string) => void;
  onChoice: (code: string, groupIdx: number, label: string) => void;
}) {
  // A saved line can carry codes since retired/renamed — surface them as
  // removable rows so an invisible-but-stuck pick can be cleared.
  const retired = picked.filter((c) => !options.some((o) => o.code === c));

  function effectiveSen(o: SpecialAddonRow): number {
    let sen = o.sellingPriceSen ?? o.selling_price_sen ?? 0;
    const groups = o.optionGroups ?? o.option_groups ?? [];
    (choices[o.code] ?? []).forEach((label, i) => {
      const hit = label
        ? groups[i]?.choices.find((c) => c.label === label)
        : undefined;
      if (hit) sen += hit.extraSen;
    });
    return sen;
  }

  return (
    <div className="rounded-md border border-border-subtle">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-semibold text-ink-secondary transition-colors hover:text-accent"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>Special Orders</span>
        <span className="text-ink-muted">({picked.length} selected)</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border-subtle p-3">
          {options.length === 0 && retired.length === 0 && (
            <span className="text-[12px] text-ink-muted">
              No specials configured.
            </span>
          )}
          {options.map((o) => {
            const on = picked.includes(o.code);
            const sen = on ? effectiveSen(o) : o.sellingPriceSen ?? o.selling_price_sen ?? 0;
            return (
              <label
                key={o.code}
                className="flex cursor-pointer items-start gap-2 text-[13px]"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={on}
                  onChange={() => onToggleCode(o.code)}
                />
                <span className="flex-1">
                  <span className="font-medium text-ink">{o.label}</span>
                  <span className="ml-2 font-mono text-[11px] text-ink-muted">
                    {sen > 0
                      ? `+${fmtCenti(sen)}`
                      : sen < 0
                        ? `−${fmtCenti(Math.abs(sen))}`
                        : "RM 0"}
                  </span>
                </span>
              </label>
            );
          })}
          {retired.map((code) => (
            <label
              key={`retired-${code}`}
              className="flex cursor-pointer items-start gap-2 text-[13px]"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked
                onChange={() => onToggleCode(code)}
              />
              <span className="flex-1">
                <span className="font-medium text-ink">{code}</span>
                <span className="ml-2 text-[11px] text-err">
                  retired — untick to remove
                </span>
              </span>
            </label>
          ))}
          {/* Follow-up choice groups for ticked add-ons. */}
          {options
            .filter(
              (o) =>
                picked.includes(o.code) &&
                (o.optionGroups ?? o.option_groups ?? []).length > 0,
            )
            .map((o) =>
              (o.optionGroups ?? o.option_groups ?? []).map((g, gi) => (
                <label key={`${o.code}-${gi}`} className="block">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                    {o.label} · {g.label}
                    {g.required && <span className="ml-0.5 text-err">*</span>}
                  </span>
                  <select
                    className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                    value={(choices[o.code] ?? [])[gi] ?? ""}
                    onChange={(e) => onChoice(o.code, gi, e.target.value)}
                  >
                    {!g.required && <option value="">None</option>}
                    {g.required && (
                      <option value="" disabled>
                        Select…
                      </option>
                    )}
                    {g.choices.map((c) => (
                      <option key={c.label} value={c.label}>
                        {c.label}
                        {c.extraSen !== 0
                          ? ` (${c.extraSen > 0 ? "+" : "−"}${fmtCenti(Math.abs(c.extraSen))})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )),
            )}
        </div>
      )}
    </div>
  );
}

// Exported for the parent's "today" default on new lines.
export { TODAY };
