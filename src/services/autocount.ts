import type { Env, ACSalesOrder, ACPurchaseOrder } from "../types";

/**
 * GLOBAL KILL SWITCH for outbound writes to AutoCount.
 *
 * Set to `true` to halt every PUT/POST/PATCH that this client would
 * normally send to the AutoCount middleware. Reads (getAll/getSince/
 * getOverdue/getOutstandingPOs) keep working — only mutations are
 * blocked. The wrapping push services still complete their D1 writes
 * locally so the dashboard reflects the change; the AutoCount round
 * trip is just skipped.
 *
 * In effect: the dashboard becomes "read-from-AutoCount, write-to-D1
 * only". Flip back to `false` to resume pushing changes upstream.
 *
 * Why a constant and not an env var: this is a deliberate human
 * decision tied to a specific environment risk (live database). It
 * should require a code edit + deploy to flip back on, not a flag in
 * the dashboard that anyone could toggle by accident.
 */
const AUTOCOUNT_WRITES_DISABLED = true;

function headers(env: Env, rid: string) {
  return {
    "X-API-KEY": env.AUTOCOUNT_API_KEY,
    "X-Request-ID": rid,
    "ngrok-skip-browser-warning": "true",
    "Content-Type": "application/json",
  };
}

export class AutoCountClient {
  constructor(private env: Env, private rid: string = crypto.randomUUID()) {}

  private url(path: string): string {
    return `${this.env.AUTOCOUNT_API_URL}${path}`;
  }

  async getSince(checkpoint: string): Promise<ACSalesOrder[]> {
    const res = await fetch(this.url(`/SalesOrder/getSince/${encodeURIComponent(checkpoint)}`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getSince HTTP ${res.status}`);
    return (await res.json()) as ACSalesOrder[];
  }

  /**
   * Full unfiltered list of every Sales Order — no Remark2/Attention/Remark4/
   * SalesExemptionExpiryDate filters, no checkpoint. Used by the manual
   * "Sync All" action; not safe to run on a cron.
   */
  async getAll(): Promise<ACSalesOrder[]> {
    const res = await fetch(this.url(`/SalesOrder/getAll`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getAll HTTP ${res.status}`);
    return (await res.json()) as ACSalesOrder[];
  }

  async getSingle(docNo: string): Promise<ACSalesOrder | null> {
    const res = await fetch(this.url(`/SalesOrder/getSingle/${encodeURIComponent(docNo)}`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getSingle HTTP ${res.status}`);
    const arr = (await res.json()) as ACSalesOrder[];
    return arr && arr.length > 0 ? arr[0] : null;
  }

  async getOverdue(): Promise<ACSalesOrder[]> {
    const res = await fetch(this.url(`/SalesOrder/getOverdue`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getOverdue HTTP ${res.status}`);
    return (await res.json()) as ACSalesOrder[];
  }

  async pushSalesOrder(payload: {
    DocNo: string;
    Remark4: string | null;
    ExpiryDate: string | null;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    const body = {
      DocNo: payload.DocNo,
      Remark4: payload.Remark4 ?? "",
      Attention: "SEAMPIFY",
      ExpiryDate: normalizeDate(payload.ExpiryDate),
    };
    if (AUTOCOUNT_WRITES_DISABLED) {
      console.warn(
        `[autocount][${this.rid}] WRITES DISABLED — skipping pushSalesOrder ${payload.DocNo}`,
        body
      );
      return { ok: true, status: 200, body: "skipped: AUTOCOUNT_WRITES_DISABLED" };
    }
    const res = await fetch(this.url(`/SalesOrder/updateFromSheet`), {
      method: "PUT",
      headers: headers(this.env, this.rid),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  }

  async getOutstandingPOs(): Promise<ACPurchaseOrder[]> {
    const res = await fetch(this.url(`/PurchaseOrder/getOutstanding`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getOutstandingPOs HTTP ${res.status}`);
    return (await res.json()) as ACPurchaseOrder[];
  }

  async pushPODates(payload: {
    docNo: string;
    date1: string | null;
    date2: string | null;
    date3: string | null;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    const body = {
      docNo: payload.docNo,
      POUDF_EDate: normalizeDate(payload.date1),
      POUDF_EDate2: normalizeDate(payload.date2),
      POUDF_EDate3: normalizeDate(payload.date3),
    };
    if (AUTOCOUNT_WRITES_DISABLED) {
      console.warn(
        `[autocount][${this.rid}] WRITES DISABLED — skipping pushPODates ${payload.docNo}`,
        body
      );
      return { ok: true, status: 200, body: "skipped: AUTOCOUNT_WRITES_DISABLED" };
    }
    const res = await fetch(this.url(`/PurchaseOrder/update-udf-dates`), {
      method: "PUT",
      headers: headers(this.env, this.rid),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  }
}

/**
 * Public read-only check — exposed so other modules (status endpoints,
 * UI banners) can detect the kill switch state without poking at the
 * private constant. Returns true when outbound writes are halted.
 */
export function isAutoCountWritesDisabled(): boolean {
  return AUTOCOUNT_WRITES_DISABLED;
}

function normalizeDate(d: string | null | undefined): string | null {
  if (!d) return null;
  return d.replace(/\//g, "-");
}

// Helper: clean phone string (strip + & - and spaces)
export function cleanPhone(p: string | null | undefined): string {
  if (!p) return "";
  return String(p).replace(/[+&\- ]/g, "");
}

// Helper: split ISO datetime on T -> date part
export function dateOnly(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.split("T")[0];
}

// Routes a sales order to a region. Returns null if it should be skipped.
export function routeRegion(o: ACSalesOrder): "WEST" | "EAST" | "SG" | null {
  const addr = (o.InvAddr3 || "").toUpperCase();
  const loc = (o.SalesLocation || "").toUpperCase();
  if (addr.includes("SINGAPORE")) return "SG";
  if (loc === "KL" || loc === "PG") return "WEST";
  if (loc === "SBH" || loc === "SRW") return "EAST";
  return null;
}
