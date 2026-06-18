// ----------------------------------------------------------------------------
// /pwp-codes — PWP (换购) voucher codes. 1:1 clone of 2990s apps/api/src/routes/
// pwp-codes.ts (PostgREST -> Drizzle). Adding a TRIGGER to a cart RESERVES N =
// rule.qty_per_trigger x qty codes; removing it frees them. The consume + mark-
// used step lives in the order route (mfg-sales-orders).
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4); owner_staff_id -> users.id INTEGER soft-ref (c.get("user").id). Uses the
// ported @shared matchComboSubset for SOFA trigger matching.
//
// Endpoints:
//   GET    /pwp-codes/mine
//   POST   /pwp-codes/reserve
//   DELETE /pwp-codes/reserve?cartLineKey=
//   GET    /pwp-codes/by-so/:docNo
//   GET    /pwp-codes/:code
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { matchComboSubset } from "@shared/index";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  pwpCodes as pwpCodesTable,
  pwpRules as pwpRulesTable,
  mfgProducts,
  sofaComboPricing,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// [] = whole category, else modelId must be in the list (null never matches a
// non-empty list). Mirrors shared/pwp.ts.
export const inList = (modelId: string | null, list: string[]): boolean =>
  list.length === 0 ? true : modelId != null && list.includes(modelId);

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function genCode(): string {
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  let digits = "";
  for (let i = 0; i < 4; i++) digits += String((buf[i] ?? 0) % 10);
  let letters = "";
  for (let i = 0; i < 4; i++) letters += LETTERS[(buf[4 + i] ?? 0) % 26];
  return `PWP-${digits}${letters}`;
}

type CodeRowDb = typeof pwpCodesTable.$inferSelect;
const toApi = (r: CodeRowDb) => ({
  code: r.code,
  ruleId: r.ruleId,
  rewardCategory: r.rewardCategory,
  eligibleRewardModelIds: r.eligibleRewardModelIds ?? [],
  rewardComboIds: r.rewardComboIds ?? [],
  type: (r.type ?? "pwp") as "pwp" | "promo",
  status: r.status,
  cartLineKey: r.cartLineKey,
  triggerItemCode: r.triggerItemCode,
  sourceDocNo: r.sourceDocNo,
  customerId: r.customerId,
});

// ── GET /mine ────────────────────────────────────────────────────────
app.get("/mine", async (c) => {
  const userId = c.get("user").id;
  const db = getDb(c.env);
  try {
    const rows = await db
      .select()
      .from(pwpCodesTable)
      .where(and(eq(pwpCodesTable.ownerStaffId, userId), eq(pwpCodesTable.status, "RESERVED")));
    return c.json({ codes: rows.map(toApi) });
  } catch (e) {
    return c.json({ error: "fetch_failed", reason: errMsg(e) }, 500);
  }
});

const reserveSchema = z.object({
  cartLineKey: z.string().min(1),
  productId: z.string().min(1),
  qty: z.number().int().min(1).default(1),
  sofaModules: z.array(z.string()).optional(),
  rewardLine: z.boolean().optional(),
});

// ── POST /reserve ────────────────────────────────────────────────────
app.post("/reserve", async (c) => {
  const userId = c.get("user").id;
  const db = getDb(c.env);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = reserveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }
  const { cartLineKey, productId, qty, rewardLine } = parsed.data;

  try {
    // 1. The trigger product.
    const prodRows = await db
      .select({ code: mfgProducts.code, category: mfgProducts.category, modelId: mfgProducts.modelId, baseModel: mfgProducts.baseModel })
      .from(mfgProducts)
      .where(eq(mfgProducts.id, productId))
      .limit(1);
    const prod = prodRows[0];
    if (!prod) return c.json({ codes: [] });
    const prodCat = String(prod.category).toUpperCase();

    // 2. Active rules.
    const ruleRows = await db
      .select({
        id: pwpRulesTable.id,
        trigger_category: pwpRulesTable.triggerCategory,
        trigger_eligible_model_ids: pwpRulesTable.triggerEligibleModelIds,
        trigger_combo_ids: pwpRulesTable.triggerComboIds,
        reward_category: pwpRulesTable.rewardCategory,
        eligible_reward_model_ids: pwpRulesTable.eligibleRewardModelIds,
        reward_combo_ids: pwpRulesTable.rewardComboIds,
        qty_per_trigger: pwpRulesTable.qtyPerTrigger,
        type: pwpRulesTable.type,
      })
      .from(pwpRulesTable)
      .where(eq(pwpRulesTable.active, true));
    const rules = ruleRows as Array<{
      id: string;
      trigger_category: string;
      trigger_eligible_model_ids: string[] | null;
      trigger_combo_ids: string[] | null;
      reward_category: string;
      eligible_reward_model_ids: string[] | null;
      reward_combo_ids: string[] | null;
      qty_per_trigger: number;
      type: string | null;
    }>;

    // 2b. Rules whose trigger matches this line.
    let matching: typeof rules;
    if (prodCat === "SOFA") {
      const sofaModules = (parsed.data.sofaModules ?? []).map((s) => s.trim()).filter(Boolean);
      if (sofaModules.length === 0) return c.json({ codes: [] });
      const sofaRules = rules.filter((r) => r.trigger_category === "SOFA" && (r.trigger_combo_ids ?? []).length > 0);
      const comboIds = [...new Set(sofaRules.flatMap((r) => r.trigger_combo_ids ?? []))];
      const combosById = new Map<string, { base_model: string; modules: string[][] }>();
      if (comboIds.length > 0) {
        const comboRows = await db
          .select({ id: sofaComboPricing.id, base_model: sofaComboPricing.baseModel, modules: sofaComboPricing.modules, deleted_at: sofaComboPricing.deletedAt })
          .from(sofaComboPricing)
          .where(inArray(sofaComboPricing.id, comboIds));
        for (const cr of comboRows) {
          if (!cr.deleted_at) combosById.set(cr.id, { base_model: cr.base_model, modules: (cr.modules as string[][]) ?? [] });
        }
      }
      matching = sofaRules.filter((r) =>
        (r.trigger_combo_ids ?? []).some((cid) => {
          const combo = combosById.get(cid);
          return !!combo && (!prod.baseModel || combo.base_model === prod.baseModel) && matchComboSubset(sofaModules, combo.modules) != null;
        }),
      );
    } else {
      matching = rules.filter((r) => r.trigger_category === prodCat && inList(prod.modelId ?? null, r.trigger_eligible_model_ids ?? []));
    }

    // 2c. Promo is one-way — a reward line never mints 'promo' codes.
    if (rewardLine) matching = matching.filter((r) => String(r.type ?? "pwp") !== "promo");

    // 3. Existing RESERVED codes for this cart line.
    const existingRows = await db
      .select()
      .from(pwpCodesTable)
      .where(and(eq(pwpCodesTable.cartLineKey, cartLineKey), eq(pwpCodesTable.status, "RESERVED")));
    const existing = existingRows;

    // 4. Reconcile each matching rule to target = qty_per_trigger x qty.
    for (const rule of matching) {
      const target = Math.max(0, Math.floor((Number(rule.qty_per_trigger) || 1) * qty));
      const mine = existing.filter((e) => e.ruleId === rule.id);
      if (mine.length < target) {
        for (let i = 0; i < target - mine.length; i++) {
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              await db.insert(pwpCodesTable).values({
                code: genCode(),
                ruleId: rule.id,
                rewardCategory: rule.reward_category as CodeRowDb["rewardCategory"],
                eligibleRewardModelIds: rule.eligible_reward_model_ids ?? [],
                rewardComboIds: rule.reward_combo_ids ?? [],
                type: rule.type ?? "pwp",
                status: "RESERVED",
                ownerStaffId: userId,
                cartLineKey,
                triggerItemCode: prod.code,
              });
              break;
            } catch (e) {
              if (attempt === 4) return c.json({ error: "reserve_failed", reason: errMsg(e) }, 500);
              // else likely a code collision (23505) -> regenerate + retry.
            }
          }
        }
      } else if (mine.length > target) {
        const surplus = mine.slice(target).map((e) => e.code);
        if (surplus.length > 0) {
          await db.delete(pwpCodesTable).where(and(inArray(pwpCodesTable.code, surplus), eq(pwpCodesTable.status, "RESERVED")));
        }
      }
    }

    // 4b. Trim RESERVED codes whose rule no longer matches this line at all.
    {
      const matchingIds = new Set(matching.map((r) => r.id));
      const strays = existing.filter((e) => !e.ruleId || !matchingIds.has(e.ruleId)).map((e) => e.code);
      if (strays.length > 0) {
        await db.delete(pwpCodesTable).where(and(inArray(pwpCodesTable.code, strays), eq(pwpCodesTable.status, "RESERVED")));
      }
    }

    // 5. Return the line's current RESERVED set.
    const finalRows = await db
      .select()
      .from(pwpCodesTable)
      .where(and(eq(pwpCodesTable.cartLineKey, cartLineKey), eq(pwpCodesTable.status, "RESERVED")));
    return c.json({ codes: finalRows.map(toApi) });
  } catch (e) {
    return c.json({ error: "reserve_failed", reason: errMsg(e) }, 500);
  }
});

// ── DELETE /reserve?cartLineKey= ─────────────────────────────────────
app.delete("/reserve", async (c) => {
  const db = getDb(c.env);
  const cartLineKey = c.req.query("cartLineKey");
  if (!cartLineKey) return c.json({ error: "cart_line_key_required" }, 400);
  try {
    await db.delete(pwpCodesTable).where(and(eq(pwpCodesTable.cartLineKey, cartLineKey), eq(pwpCodesTable.status, "RESERVED")));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "free_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /by-so/:docNo ────────────────────────────────────────────────
app.get("/by-so/:docNo", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const rows = await db
      .select()
      .from(pwpCodesTable)
      .where(and(eq(pwpCodesTable.sourceDocNo, docNo), inArray(pwpCodesTable.status, ["USED", "AVAILABLE"])));
    return c.json({ codes: rows.map(toApi) });
  } catch (e) {
    return c.json({ error: "fetch_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /:code ───────────────────────────────────────────────────────
app.get("/:code", async (c) => {
  const userId = c.get("user").id;
  const db = getDb(c.env);
  const code = c.req.param("code");
  const rewardCategory = (c.req.query("rewardCategory") ?? "").toUpperCase();
  const rewardModelId = c.req.query("rewardModelId") ?? "";
  const rewardComboId = c.req.query("rewardComboId") ?? "";
  const customerId = c.req.query("customerId") ?? "";

  try {
    const rows = await db.select().from(pwpCodesTable).where(eq(pwpCodesTable.code, code)).limit(1);
    const r = rows[0];
    if (!r) return c.json({ valid: false, reason: "not_found" });

    const redeemable = r.status === "AVAILABLE" || (r.status === "RESERVED" && r.ownerStaffId === userId);
    if (!redeemable) return c.json({ valid: false, reason: r.status === "USED" ? "already_used" : "not_redeemable" });

    if (rewardCategory && rewardCategory !== String(r.rewardCategory).toUpperCase()) {
      return c.json({ valid: false, reason: "reward_category_mismatch" });
    }
    if (String(r.rewardCategory).toUpperCase() === "SOFA") {
      const combos = r.rewardComboIds ?? [];
      if (!rewardComboId || !combos.includes(rewardComboId)) {
        return c.json({ valid: false, reason: "reward_combo_ineligible" });
      }
    } else if (!inList(rewardModelId || null, r.eligibleRewardModelIds ?? [])) {
      return c.json({ valid: false, reason: "reward_model_ineligible" });
    }

    let customerMatches = true;
    if (r.status === "AVAILABLE" && r.customerId) {
      customerMatches = customerId !== "" ? customerId === r.customerId : true;
    }

    return c.json({ valid: true, rewardCategory: r.rewardCategory, customerMatches, status: r.status, type: (r.type ?? "pwp") as "pwp" | "promo" });
  } catch (e) {
    return c.json({ error: "fetch_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
