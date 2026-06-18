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
