import { Hono } from "hono";
import type { Env } from "../types";

// Companies list for the top-bar company switcher — Phase 0c of the
// multi-company merge. Reads what companyContext (mounted on /api/*) already
// resolved and stashed on the Hono context; NO DB read of its own. Any
// authenticated user may call it — the switcher is a UI affordance, not a
// gated admin surface, so no new permission verb is introduced.
//
// NO-OP property: pre-activation (companies master absent), companyContext
// leaves the context vars undefined, so this returns { companies: [] } and the
// front-end switcher stays hidden. Single-company Houzs is unchanged.

const app = new Hono<{ Bindings: Env }>();

/** GET /api/companies — active companies + which one is active for this request. */
app.get("/", (c) => {
  return c.json({
    companies: c.get("companies") ?? [],
    activeCompanyId: c.get("companyId") ?? null,
    activeCompanyCode: c.get("companyCode") ?? null,
  });
});

export default app;
