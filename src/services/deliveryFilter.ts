/**
 * Shared SQL fragment defining the "Delivery Orders" view.
 *
 * Mirrors the rules the .NET middleware applies in /SalesOrder/getSince:
 *   Remark2 ∈ {ready, ready (partial)}
 *   Attention not containing 'seampify'
 *   Remark4 not containing confirm/comfirm/confrim/'done scheduling'
 *   Not transferred to a cancelled DO (transfer_to prefix 'XS')
 *   expiry_date present
 *
 * Both routes/orders.ts and routes/maps.ts (and the planner later) use
 * this so the definition stays in one place.
 *
 * Use as: `WHERE ${DELIVERY_WHERE}` against the alias `so` for sales_orders.
 */
export const DELIVERY_WHERE = `
  LOWER(COALESCE(so.remark2, '')) IN ('ready', 'ready (partial)')
  AND (so.attention IS NULL OR LOWER(so.attention) NOT LIKE '%seampify%')
  AND (so.remark4 IS NULL OR (
    LOWER(so.remark4) NOT LIKE '%confirm%'
    AND LOWER(so.remark4) NOT LIKE '%comfirm%'
    AND LOWER(so.remark4) NOT LIKE '%confrim%'
    AND LOWER(so.remark4) NOT LIKE '%done scheduling%'
  ))
  AND (so.transfer_to IS NULL OR so.transfer_to NOT LIKE 'XS%')
  AND so.expiry_date IS NOT NULL AND so.expiry_date <> ''
`;
