// amendment-lines — building the so_amendment_lines rows for ONE amendment.
//
// Extracted from the CREATE endpoint (POST /mfg-sales-orders/:docNo/amendments)
// so the amendment-editor work still to come builds its rows from the same
// function rather than a second copy. Two copies would eventually disagree about
// what a line snapshot contains — and the snapshot is the approver's only
// evidence of what the line WAS, so a disagreement there is a disagreement about
// what is being approved.
//
// The server-side itemGroup stamp is the load-bearing part. buildVariantSummary
// BRANCHES on the item group, so a card rendered without it formats a bedframe
// line by the sofa rule and silently drops DIVAN / GAP / T.Heights from the
// Requesting column — which is exactly how a colour-only amendment came to look
// like a wiped spec (SO-2607-018/A1). It is read from mfg_sales_order_items,
// never from the client: the snapshot must come from the record, not from the
// browser that is asking to change it.

export type SubmittedAmendmentLine = {
  salesOrderItemId?: string | null;
  changeType?: string;
  newItemCode?: string | null;
  newVariants?: unknown;
  newQty?: number | null;
  newUnitPriceSen?: number | null;
  oldSnapshot?: unknown;
};

export type AmendmentLineRow = {
  amendment_id: string;
  sales_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_variants: unknown;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  old_snapshot: Record<string, unknown> | null;
};

export type BuildLineRowsResult =
  | { ok: true; rows: AmendmentLineRow[] }
  /* An unreadable item group is an ERROR, never a blank. `unreadable` means the
     lookup itself failed; `missing` means the payload references lines that are
     not on this order, so their "before" side cannot be trusted. Writing the
     amendment anyway would put a request in the approval queue whose evidence
     is fabricated. */
  | { ok: false; reason: 'unreadable' }
  | { ok: false; reason: 'missing'; missingIds: string[] };

/**
 * Resolve every referenced SO line's item_group from the order itself, then
 * build the so_amendment_lines rows with that group stamped into old_snapshot.
 *
 * `sb` is the request-scoped Supabase client; `docNo` bounds the lookup to the
 * amendment's own Sales Order so an id from another order cannot be smuggled in.
 */
export async function buildAmendmentLineRows(
  sb: any,
  docNo: string,
  amendmentId: string,
  lines: SubmittedAmendmentLine[],
): Promise<BuildLineRowsResult> {
  const referencedItemIds = [...new Set(
    lines
      .map((l) => l.salesOrderItemId)
      .filter((x): x is string => typeof x === 'string' && x.length > 0),
  )];

  const itemGroupById = new Map<string, string | null>();
  if (referencedItemIds.length > 0) {
    const { data, error } = await sb.from('mfg_sales_order_items')
      .select('id, item_group').eq('doc_no', docNo).in('id', referencedItemIds);
    if (error) return { ok: false, reason: 'unreadable' };
    for (const r of (data ?? []) as Array<{ id: string; item_group: string | null }>) {
      itemGroupById.set(r.id, r.item_group);
    }
    const missingIds = referencedItemIds.filter((id) => !itemGroupById.has(id));
    if (missingIds.length > 0) return { ok: false, reason: 'missing', missingIds };
  }

  const rows = lines.map((l) => {
    const snapshot = (l.oldSnapshot ?? null) as Record<string, unknown> | null;
    /* An ADD line has no persisted item and therefore no old_snapshot; its group
       rides on the requested blob instead — the same key so-revision's ADD path
       already reads. */
    const group = l.salesOrderItemId
      ? itemGroupById.get(l.salesOrderItemId) ?? null
      : ((l.newVariants as Record<string, unknown> | null)?.itemGroup ?? null);
    return {
      amendment_id:        amendmentId,
      sales_order_item_id: l.salesOrderItemId ?? null,   // null = added line
      change_type:         String(l.changeType ?? 'SPEC'),
      new_item_code:       l.newItemCode ?? null,
      new_variants:        l.newVariants ?? null,
      new_qty:             l.newQty ?? null,
      new_unit_price_sen:  l.newUnitPriceSen ?? null,
      old_snapshot:        snapshot || group != null
        ? { ...(snapshot ?? {}), ...(group != null ? { itemGroup: String(group) } : {}) }
        : null,
    };
  });

  return { ok: true, rows };
}

/* Plain-language bodies for the two failure modes, so every caller of the
   builder refuses in the same words. */
export const LINE_BUILD_ERRORS = {
  unreadable: {
    error: 'create_failed',
    reason: 'Could not read the current lines of this Sales Order, so nothing was saved. Please try again.',
  },
  missing: (n: number) => ({
    error: 'amendment_line_not_on_order',
    reason: `${n} of the changed lines are no longer on this Sales Order. Reload the order and submit again.`,
  }),
} as const;

