// Pure commission math for the HR module. No I/O, no DB, no React — safe to
// run on the CF Workers API (authoritative) and reuse client-side for preview.
// Money in centi (sen, integer); rates in bps (integer, 100 bps = 1%).

export type HrTier = 'sales' | 'manager';

export interface CommissionConfig {
  baseBps: number;
  personalKpiThresholdCenti: number;
  personalKpiBonusBps: number;
  showroomKpiThresholdCenti: number;
  showroomKpiBonusBps: number;
  overrideBaseBps: number;
  overrideKpiBonusBps: number;
}

export interface SalespersonInput {
  staffId: string;
  tier: HrTier;
  personalGoodsCenti: number;
  itemKpiCenti: number;
}

export interface CommissionRow {
  staffId: string;
  tier: HrTier;
  personalGoodsCenti: number;
  personalRateBps: number;
  personalCommissionCenti: number;
  overrideRateBps: number;
  overrideCommissionCenti: number;
  itemKpiCenti: number;
  totalCenti: number;
}

const applyBps = (centi: number, bps: number): number => Math.round((centi * bps) / 10_000);

/**
 * Compute commission for every salesperson in one showroom. `showroomGoodsCenti`
 * is the WHOLE showroom's goods value (used for both the 400k threshold and the
 * manager override base — managers override the entire showroom, including their
 * own sales).
 */
export const computeShowroomCommission = (
  config: CommissionConfig,
  showroomGoodsCenti: number,
  salespeople: SalespersonInput[],
): CommissionRow[] => {
  const showroomKpiHit = showroomGoodsCenti >= config.showroomKpiThresholdCenti;
  return salespeople.map((p) => {
    const personalKpiHit = p.personalGoodsCenti >= config.personalKpiThresholdCenti;
    const personalRateBps =
      config.baseBps +
      (personalKpiHit ? config.personalKpiBonusBps : 0) +
      (showroomKpiHit ? config.showroomKpiBonusBps : 0);
    const personalCommissionCenti = applyBps(p.personalGoodsCenti, personalRateBps);

    const isManager = p.tier === 'manager';
    const overrideRateBps = isManager
      ? config.overrideBaseBps + (showroomKpiHit ? config.overrideKpiBonusBps : 0)
      : 0;
    const overrideCommissionCenti = isManager ? applyBps(showroomGoodsCenti, overrideRateBps) : 0;

    return {
      staffId: p.staffId,
      tier: p.tier,
      personalGoodsCenti: p.personalGoodsCenti,
      personalRateBps,
      personalCommissionCenti,
      overrideRateBps,
      overrideCommissionCenti,
      itemKpiCenti: p.itemKpiCenti,
      totalCenti: personalCommissionCenti + overrideCommissionCenti + p.itemKpiCenti,
    };
  });
};

export interface ItemKpiFlag {
  flagType: 'product' | 'fabric' | 'special';
  ref: string;
  bonusCenti: number;
}

export interface KpiLine {
  itemCode: string;
  qty: number;
  fabricId: string | null;
  specialCodes: string[];
}

/** Bonus earned by one order line against the active flags (qty × amount, summed). */
export const lineKpiCenti = (line: KpiLine, flags: ItemKpiFlag[]): number => {
  let total = 0;
  for (const f of flags) {
    const matched =
      (f.flagType === 'product' && line.itemCode === f.ref) ||
      (f.flagType === 'fabric' && line.fabricId === f.ref) ||
      (f.flagType === 'special' && line.specialCodes.includes(f.ref));
    if (matched) total += line.qty * f.bonusCenti;
  }
  return total;
};

// ── item-KPI as a goods EXCLUSION (Loo 2026-06-20) ───────────────────────────
// An item-KPI-flagged purchase earns a FIXED bonus (e.g. RM 50) INSTEAD of the
// percentage commission on the flagged portion — never both ("no double
// commission"). So the flagged amount is removed from the goods that drive BOTH
// the % commission AND the 100k / 400k thresholds.
//
// The flagged thing is one purchased item — a "unit". A POS sofa build is stored
// as several per-module SO lines (so-sofa-split) that all carry the SAME fabric,
// and its fabric-tier Δ is one flat figure spread across those lines. So module
// lines of one build collapse back into ONE unit: the bonus and the exclusion
// each count ONCE per built item, not once per module. Every non-sofa line is a
// unit of one.
//
// What gets excluded, per flag type (Loo's worked example: a sofa whose base is
// RM 3,000 with a RM 125 fabric-tier add-on, fabric flagged at RM 50 → goods
// stays RM 3,000, salesperson earns the fixed RM 50, the RM 125 is dropped):
//   · fabric  → the fabric-tier add-on Δ (qty × per-item Δ) — the base price stays goods
//   · special → the special-order surcharge (qty × per-item)
//   · product → the whole unit total (the product itself IS the KPI item)
// Capped at the unit total so a unit's goods can never go negative.

export interface KpiUnit {
  /** Every SKU code in the unit — a split sofa carries one per module. */
  itemCodes: string[];
  /** Items purchased (a build's qty; uniform across its module lines). */
  qty: number;
  fabricId: string | null;
  specialCodes: string[];
  /** Σ of the unit's line totals (goods, qty-inclusive, post-discount), centi. */
  lineTotalCenti: number;
  /** Per-ITEM fabric-tier add-on Δ charged on this unit (centi); 0 when none. */
  fabricAddonUnitCenti: number;
  /** Per-ITEM special-order surcharge on this unit (centi); 0 when none. */
  specialSurchargeUnitCenti: number;
}

const flagMatchesUnit = (
  f: ItemKpiFlag,
  u: Pick<KpiUnit, 'itemCodes' | 'fabricId' | 'specialCodes'>,
): boolean =>
  (f.flagType === 'product' && u.itemCodes.includes(f.ref)) ||
  (f.flagType === 'fabric' && u.fabricId === f.ref) ||
  (f.flagType === 'special' && u.specialCodes.includes(f.ref));

/** Does any active flag fire on this unit? (drives the kpiDetail breakdown.) */
export const unitMatchesAnyKpi = (u: KpiUnit, flags: ItemKpiFlag[]): boolean =>
  flags.some((f) => flagMatchesUnit(f, u));

/** Whether one flag fires on this unit — exported so the API's per-flag detail
 *  rollup matches this single source of truth instead of re-deriving the test. */
export const kpiFlagFiresOnUnit = flagMatchesUnit;

/** Fixed item-KPI bonus earned by one unit (qty × amount, summed over matches). */
export const unitKpiCenti = (u: KpiUnit, flags: ItemKpiFlag[]): number => {
  let total = 0;
  for (const f of flags) if (flagMatchesUnit(f, u)) total += u.qty * f.bonusCenti;
  return total;
};

/** Goods centi to EXCLUDE from this unit because it earns the fixed item-KPI
 *  bonus instead of percentage commission. A product flag drops the whole unit;
 *  fabric / special flags drop only their add-on. Capped at the unit total. */
export const unitKpiExcludedCenti = (u: KpiUnit, flags: ItemKpiFlag[]): number => {
  let excluded = 0;
  let wholeUnit = false;
  for (const f of flags) {
    if (!flagMatchesUnit(f, u)) continue;
    if (f.flagType === 'product') wholeUnit = true;
    else if (f.flagType === 'fabric') excluded += u.qty * u.fabricAddonUnitCenti;
    else if (f.flagType === 'special') excluded += u.qty * u.specialSurchargeUnitCenti;
  }
  if (wholeUnit) return Math.max(0, u.lineTotalCenti);
  return Math.min(Math.max(0, excluded), Math.max(0, u.lineTotalCenti));
};
