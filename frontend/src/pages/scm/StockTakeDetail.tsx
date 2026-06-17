// ----------------------------------------------------------------------------
// StockTakeDetail — at /stock-takes/:id (PR — Inv PR5).
//
// 1:1 clone of 2990s apps/backend/src/pages/StockTakeDetail.tsx.
//   OPEN: edit counted_qty per line, Save -> PATCH /lines, Post -> flips POSTED
//     and writes one ADJUSTMENT movement per non-zero-variance line.
//   POSTED/CANCELLED: read-only with variance summary; POSTED can be Undone
//     (reverses the ADJUSTMENTs).
//
// SEAM changes (same playbook as GoodsReceivedDetail):
//   - Data layer: 2990s lib/stock-takes-queries -> co-located ./stock-takes-
//     queries (Houzs api client + react-query). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button.
//     react-router -> react-router-dom. CSS -> ./StockDoc.module.css. 2990s
//     SkeletonDetailPage -> plain loading text (done-slice precedent).
//   - STRATEGY-2: 2990s buildVariantSummary (furniture variant formatter) +
//     fmtDateOrDash (shared format helper) are DROPPED — "Description 2" shows the
//     line's stored description2 (none in Houzs) else em-dash; date is formatted
//     inline. Houzs materials have no item-group/variant axes.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Save, X, Trash2, Send, Ban, AlertTriangle, Search, Wand2, Undo2 } from "lucide-react";
import { Button } from "../../components/Button";
import {
  useStockTakeDetail,
  useUpdateStockTakeLines,
  usePostStockTake,
  useCancelStockTake,
  useReverseStockTake,
  useDeleteStockTake,
  type StockTakeStatus,
  type StockTakeLine,
} from "./stock-takes-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./StockDoc.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_TONE: Record<StockTakeStatus, { bg: string; fg: string; label: string }> = {
  OPEN: { bg: "rgba(34, 31, 32, 0.08)", fg: "var(--fg-muted)", label: "Open" },
  POSTED: { bg: "rgba(47, 93, 79, 0.16)", fg: "var(--c-secondary-a, #2F5D4F)", label: "Posted" },
  CANCELLED: { bg: "rgba(184, 51, 31, 0.10)", fg: "var(--c-festive-b, #B8331F)", label: "Cancelled" },
};

const fmtDateTime = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/-/g, "/");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
};

// STRATEGY-2: inline date formatter (2990s @2990s/shared fmtDateOrDash dropped).
const fmtDateOrDash = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const scopeLabel = (scopeType: string, scopeValue: string | null): string => {
  if (scopeType === "ALL") return "All SKUs";
  if (scopeType === "CATEGORY") return `Category · ${scopeValue ?? "—"}`;
  if (scopeType === "CODE_PREFIX") return `Prefix · ${scopeValue ?? "—"}`;
  return scopeType;
};

// Local row state: counted_qty as string so empty input = null, not 0.
type LineDraft = {
  id: string;
  productCode: string;
  productName: string | null;
  systemQty: number;
  countedQtyInput: string; // '' means uncounted
  notes: string;
  origCountedQty: number | null;
  origNotes: string;
};

const toDraft = (l: StockTakeLine): LineDraft => ({
  id: l.id,
  productCode: l.product_code,
  productName: l.product_name,
  systemQty: l.system_qty,
  countedQtyInput: l.counted_qty == null ? "" : String(l.counted_qty),
  notes: l.notes ?? "",
  origCountedQty: l.counted_qty,
  origNotes: l.notes ?? "",
});

const parseCounted = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Math.max(0, Math.floor(Number(s)));
  if (!Number.isFinite(n)) return null;
  return n;
};

const varianceOf = (d: LineDraft): number | null => {
  const c = parseCounted(d.countedQtyInput);
  if (c == null) return null;
  return c - d.systemQty;
};

export const StockTakeDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();

  const detail = useStockTakeDetail(id ?? null);
  const update = useUpdateStockTakeLines();
  const post = usePostStockTake();
  const cancel = useCancelStockTake();
  const reverse = useReverseStockTake();
  const del = useDeleteStockTake();

  const [lines, setLines] = useState<LineDraft[]>([]);
  const [search, setSearch] = useState<string>("");
  const [dirty, setDirty] = useState<boolean>(false);

  useEffect(() => {
    if (!detail.data) return;
    setLines(detail.data.lines.map(toDraft));
    setDirty(false);
  }, [detail.data]);

  const status: StockTakeStatus | undefined = detail.data?.take.status;
  const isDraft = status === "OPEN"; // local var name kept for diff minimization; refers to OPEN state
  const isPosted = status === "POSTED";
  const tone = status ? STATUS_TONE[status] : null;

  const filteredLines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter(
      (l) => l.productCode.toLowerCase().includes(q) || (l.productName ?? "").toLowerCase().includes(q),
    );
  }, [lines, search]);

  // ── Aggregates ───────────────────────────────────────────────────────
  const totals = useMemo(() => {
    let counted = 0;
    let uncounted = 0;
    let variancePos = 0;
    let varianceNeg = 0;
    let nonZeroVarianceLines = 0;
    for (const l of lines) {
      const v = varianceOf(l);
      if (v == null) {
        uncounted += 1;
        continue;
      }
      counted += 1;
      if (v > 0) variancePos += v;
      if (v < 0) varianceNeg += v; // negative number
      if (v !== 0) nonZeroVarianceLines += 1;
    }
    return {
      counted,
      uncounted,
      variancePos,
      varianceNeg,
      varianceNet: variancePos + varianceNeg,
      nonZeroVarianceLines,
      totalLines: lines.length,
    };
  }, [lines]);

  // ── Local edit helpers ───────────────────────────────────────────────
  const setLine = (lineId: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((l) => (l.id === lineId ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const matchSystem = (lineId: string) => {
    setLines((cur) => cur.map((l) => (l.id === lineId ? { ...l, countedQtyInput: String(l.systemQty) } : l)));
    setDirty(true);
  };

  const matchAllToSystem = async () => {
    if (!(await dialog.confirm("Fill EVERY counted qty with the system qty? This sets variance to 0 for all lines."))) return;
    setLines((cur) => cur.map((l) => ({ ...l, countedQtyInput: String(l.systemQty) })));
    setDirty(true);
  };

  // ── Mutations ────────────────────────────────────────────────────────
  const onSave = () => {
    if (!id) return;
    // Build diff payload — only lines whose counted or notes changed.
    const changed = lines.filter((l) => {
      const parsedCounted = parseCounted(l.countedQtyInput);
      return parsedCounted !== l.origCountedQty || l.notes !== l.origNotes;
    });
    if (changed.length === 0) {
      setDirty(false);
      return;
    }
    update.mutate(
      {
        id,
        lines: changed.map((l) => ({
          id: l.id,
          countedQty: parseCounted(l.countedQtyInput),
          notes: l.notes.trim() ? l.notes.trim() : null,
        })),
      },
      {
        onSuccess: () => {
          setDirty(false);
          detail.refetch();
        },
        onError: (err) => toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`),
      },
    );
  };

  const onPost = async () => {
    if (!id) return;
    if (dirty) {
      toast.error("Save your counts before posting.");
      return;
    }
    const summary =
      `Lines: ${totals.totalLines} (${totals.counted} counted, ${totals.uncounted} untouched)\n` +
      `Variance lines: ${totals.nonZeroVarianceLines}\n` +
      `Net variance: ${totals.varianceNet > 0 ? "+" : ""}${totals.varianceNet}`;
    const proceed = await dialog.confirm(
      `Post this stock take?\n\n${summary}\n\nOne ADJUSTMENT movement will be written per non-zero-variance line. Untouched lines (no counted qty) are skipped.`,
    );
    if (!proceed) return;
    post.mutate(id, {
      onSuccess: (res) => {
        detail.refetch();
        if (res.movementErrors && res.movementErrors.length > 0) {
          toast.warning(
            `Stock take posted, but adjustment write failed:\n\n${res.movementErrors.join("\n")}\n\nFix manually via Stock Adjustments.`,
          );
        } else {
          toast.success(`Posted. ${res.movementsWritten} adjustment movement${res.movementsWritten === 1 ? "" : "s"} written.`);
        }
      },
      onError: (err) => toast.error(`Post failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  const onCancel = async () => {
    if (!id) return;
    if (!(await dialog.confirm("Cancel this OPEN stock take? It will be marked cancelled and locked."))) return;
    cancel.mutate(id, {
      onSuccess: () => detail.refetch(),
      onError: (err) => toast.error(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  const onReverse = async () => {
    if (!id) return;
    const proceed = await dialog.confirm(
      "Undo this posted stock take?\n\n" +
        "The stock changes it made will be reversed — every item goes back to the quantity it had before this count was posted. " +
        "This count will then be marked Cancelled and locked.\n\n" +
        "To count again, start a new stock take.",
    );
    if (!proceed) return;
    reverse.mutate(id, {
      onSuccess: (res) => {
        detail.refetch();
        if (res.movementErrors && res.movementErrors.length > 0) {
          toast.warning(
            `Undone, but reversing the stock changes failed:\n\n${res.movementErrors.join("\n")}\n\nFix manually via Stock Adjustments.`,
          );
        } else {
          toast.success(`Undone. ${res.movementsReversed} stock change${res.movementsReversed === 1 ? "" : "s"} reversed.`);
        }
      },
      onError: (err) => toast.error(`Undo failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  const onDelete = async () => {
    if (!id) return;
    if (!(await dialog.confirm("Delete this OPEN stock take permanently? The count sheet will be lost."))) return;
    del.mutate(id, {
      onSuccess: () => navigate("/stock-takes"),
      onError: (err) => toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  // ── Render ───────────────────────────────────────────────────────────
  if (detail.isLoading) {
    return (
      <div className={styles.page}>
        <p className={styles.subtitle}>Loading…</p>
      </div>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <div className={styles.page}>
        <p className={styles.subtitle}>{detail.error instanceof Error ? detail.error.message : "Stock take not found."}</p>
        <Link to="/stock-takes">Back to Stock Takes</Link>
      </div>
    );
  }

  const t = detail.data.take;

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/stock-takes" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Stock Takes</span>
          </Link>
          <h1 className={styles.title}>
            {t.take_no}
            {tone && (
              <span
                style={{
                  marginLeft: "var(--space-3)",
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "4px 10px",
                  borderRadius: "var(--radius-pill)",
                  fontFamily: "var(--font-button)",
                  fontSize: "var(--fs-12)",
                  fontWeight: 600,
                  background: tone.bg,
                  color: tone.fg,
                  letterSpacing: "0.04em",
                  verticalAlign: "middle",
                }}
              >
                {tone.label}
              </span>
            )}
          </h1>
          <p className={styles.subtitle}>
            Created {fmtDateTime(t.created_at)}
            {t.posted_at ? ` · Posted ${fmtDateTime(t.posted_at)}` : ""}
            {t.cancelled_at ? ` · Cancelled ${fmtDateTime(t.cancelled_at)}` : ""}
          </p>
        </div>
        <div className={styles.actions}>
          {isDraft && (
            <>
              <Button variant="ghost" onClick={onDelete} disabled={del.isPending}>
                <Trash2 {...ICON} /> Delete
              </Button>
              <Button variant="ghost" onClick={onCancel} disabled={cancel.isPending}>
                <Ban {...ICON} /> Cancel
              </Button>
              <Button variant="ghost" onClick={onSave} disabled={!dirty || update.isPending}>
                <Save {...ICON} /> {update.isPending ? "Saving…" : "Save Counts"}
              </Button>
              <Button variant="primary" onClick={onPost} disabled={post.isPending || dirty}>
                <Send {...ICON} /> {post.isPending ? "Posting…" : "Post"}
              </Button>
            </>
          )}
          {isPosted && (
            <Button variant="ghost" onClick={onReverse} disabled={reverse.isPending}>
              <Undo2 {...ICON} /> {reverse.isPending ? "Undoing…" : "Undo"}
            </Button>
          )}
          {!isDraft && (
            <Button variant="ghost" onClick={() => navigate("/stock-takes")}>
              <X {...ICON} /> Close
            </Button>
          )}
        </div>
      </div>

      {/* ── Header card ─────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Setup</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Warehouse</span>
              <div style={{ padding: "8px 0", fontFamily: "var(--font-mono)", fontSize: "var(--fs-13)" }}>
                {t.warehouse ? `${t.warehouse.code} · ${t.warehouse.name}` : t.warehouse_id}
              </div>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Take Date</span>
              <div style={{ padding: "8px 0", fontSize: "var(--fs-13)" }}>{fmtDateOrDash(t.take_date)}</div>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Scope</span>
              <div style={{ padding: "8px 0", fontSize: "var(--fs-13)" }}>{scopeLabel(t.scope_type, t.scope_value)}</div>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <div style={{ padding: "8px 0", fontSize: "var(--fs-13)", color: t.notes ? "var(--c-ink)" : "var(--fg-muted)" }}>
                {t.notes || "(none)"}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Variance Summary ────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Variance Summary</h2>
        </div>
        <div className={styles.cardBody}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--space-3)" }}>
            <SummaryStat label="Total lines" value={totals.totalLines.toString()} />
            <SummaryStat label="Counted" value={totals.counted.toString()} />
            <SummaryStat label="Untouched" value={totals.uncounted.toString()} tone={totals.uncounted > 0 ? "muted" : undefined} />
            <SummaryStat label="Variance lines" value={totals.nonZeroVarianceLines.toString()} />
            <SummaryStat label="+ Found" value={`+${totals.variancePos.toLocaleString("en-MY")}`} tone={totals.variancePos > 0 ? "positive" : "muted"} />
            <SummaryStat label="− Lost" value={totals.varianceNeg.toLocaleString("en-MY")} tone={totals.varianceNeg < 0 ? "negative" : "muted"} />
            <SummaryStat
              label="Net"
              value={`${totals.varianceNet > 0 ? "+" : ""}${totals.varianceNet.toLocaleString("en-MY")}`}
              tone={totals.varianceNet > 0 ? "positive" : totals.varianceNet < 0 ? "negative" : "muted"}
            />
          </div>
        </div>
      </section>

      {/* ── Lines ───────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>
            Count Sheet
            <span style={{ marginLeft: 8, fontSize: "var(--fs-12)", color: "var(--fg-muted)", fontWeight: 400 }}>
              {filteredLines.length} of {lines.length} shown
            </span>
          </h2>
          {isDraft && (
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  background: "var(--c-paper)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius-md)",
                }}
              >
                <Search size={14} strokeWidth={1.75} style={{ color: "var(--fg-muted)" }} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by code / name…"
                  style={{
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontFamily: "var(--font-sans)",
                    fontSize: "var(--fs-13)",
                    width: 200,
                    color: "var(--c-ink)",
                  }}
                />
              </div>
              <Button variant="ghost" onClick={matchAllToSystem}>
                <Wand2 size={14} strokeWidth={1.75} /> Fill all to system
              </Button>
            </div>
          )}
        </div>
        <div className={styles.cardBody}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: "18%" }}>SKU</th>
                <th>Name</th>
                <th>Description 2</th>
                <th style={{ width: 110, textAlign: "right" }}>System Qty</th>
                <th style={{ width: 130, textAlign: "right" }}>Counted Qty</th>
                <th style={{ width: 110, textAlign: "right" }}>Variance</th>
                {isDraft && <th style={{ width: 110 }} />}
              </tr>
            </thead>
            <tbody>
              {filteredLines.length === 0 && (
                <tr>
                  <td colSpan={isDraft ? 7 : 6} className={styles.emptyRow}>
                    {lines.length === 0 ? "No lines on this stock take." : "No lines match the search."}
                  </td>
                </tr>
              )}
              {filteredLines.map((ln) => {
                const v = varianceOf(ln);
                const isUntouched = v == null;
                const varianceColor = isUntouched
                  ? "var(--fg-muted)"
                  : v! > 0
                    ? "var(--c-secondary-a, #2F5D4F)"
                    : v! < 0
                      ? "var(--c-festive-b, #B8331F)"
                      : "var(--fg-muted)";
                return (
                  <tr key={ln.id}>
                    <td>
                      <span className={styles.codeCell} style={{ fontFamily: "var(--font-mono)" }}>
                        {ln.productCode}
                      </span>
                    </td>
                    <td style={{ fontSize: "var(--fs-13)" }}>{ln.productName || <span className={styles.muted}>—</span>}</td>
                    {/* "Description 2": STRATEGY-2 — Houzs stock-take lines carry no
                        description2/variant axes -> em-dash. buildVariantSummary
                        (furniture formatter) dropped. */}
                    <td style={{ fontSize: "var(--fs-13)" }}>
                      <span className={styles.muted}>—</span>
                    </td>
                    <td className={styles.tableRight} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-13)" }}>
                      {ln.systemQty.toLocaleString("en-MY")}
                    </td>
                    <td className={styles.tableRight}>
                      {isDraft ? (
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={ln.countedQtyInput}
                          onChange={(e) => setLine(ln.id, { countedQtyInput: e.target.value })}
                          placeholder="—"
                          className={styles.fieldInput}
                          style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: isUntouched ? "var(--fg-muted)" : "var(--c-ink)" }}
                        />
                      ) : (
                        <span
                          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-13)", color: isUntouched ? "var(--fg-muted)" : "var(--c-ink)" }}
                        >
                          {isUntouched ? "—" : Number(ln.countedQtyInput).toLocaleString("en-MY")}
                        </span>
                      )}
                    </td>
                    <td
                      className={styles.tableRight}
                      style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-13)", color: varianceColor, fontWeight: v && v !== 0 ? 600 : 400 }}
                    >
                      {isUntouched ? "—" : `${v! > 0 ? "+" : ""}${v!.toLocaleString("en-MY")}`}
                    </td>
                    {isDraft && (
                      <td>
                        <button
                          type="button"
                          onClick={() => matchSystem(ln.id)}
                          className={styles.chip}
                          title="Set counted = system (zero variance)"
                          style={{ fontSize: "var(--fs-11)", cursor: "pointer" }}
                        >
                          Match
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>

          {isDraft && totals.uncounted > 0 && (
            <div
              style={{
                marginTop: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)",
                background: "rgba(34, 31, 32, 0.04)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--fs-13)",
                color: "var(--fg-muted)",
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--space-2)",
              }}
            >
              <AlertTriangle size={16} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                <strong>
                  {totals.uncounted} line{totals.uncounted === 1 ? "" : "s"} untouched.
                </strong>{" "}
                On Post these are skipped (no adjustment written). Click "Match" or type a count to include them.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

// ── Small inline component for the variance summary cards ──────────────
type SummaryTone = "positive" | "negative" | "muted";
const SummaryStat = (props: { label: string; value: string; tone?: SummaryTone }) => {
  const color =
    props.tone === "positive"
      ? "var(--c-secondary-a, #2F5D4F)"
      : props.tone === "negative"
        ? "var(--c-festive-b, #B8331F)"
        : props.tone === "muted"
          ? "var(--fg-muted)"
          : "var(--c-ink)";
  return (
    <div style={{ padding: "var(--space-3)", background: "var(--c-cream)", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
      <div style={{ fontSize: "var(--fs-11)", color: "var(--fg-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>{props.label}</div>
      <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "var(--fs-18, 18px)", fontWeight: 600, color }}>{props.value}</div>
    </div>
  );
};
