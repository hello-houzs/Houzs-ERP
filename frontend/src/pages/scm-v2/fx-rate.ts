/**
 * The ONE rule for turning a keyed or stored foreign-exchange rate into the
 * number the money is actually converted at.
 *
 * WHY THIS FILE EXISTS — the screen and the write disagreed about zero.
 *
 * Every create/update handler in this folder already agreed that a blank,
 * zero, negative or unparseable foreign rate posts at 1, and each inlined its
 * own copy of that rule:
 *
 *     (Number(x) > 0 && Number.isFinite(Number(x))) ? Number(x) : 1
 *
 * The on-screen previews sitting a few lines away — including the two labelled
 * "posted to GL" — inlined a DIFFERENT rule:
 *
 *     Number(x) || 0
 *
 * which falls back to ZERO. So while the operator was still typing a rate, or
 * for any record whose stored rate was ever null or unparseable, the screen
 * read "= RM 0.00 posted to GL" for a voucher the backend would post at full
 * value. The preview was not merely imprecise, it contradicted the write it
 * was previewing, and it did so on the number the operator uses to decide
 * whether to press the button.
 *
 * Two disagreeing rules across six files is how they came to disagree in the
 * first place, so both halves now call this. The write paths keep their exact
 * previous behaviour (identical rule, identical result); only the previews
 * change, from a confident 0 to the rate that will really be used.
 *
 * A rate of 0 is treated as UNSET rather than as a real "converts to nothing"
 * rate, for the same reason a 0/0 3PL rate is not a free delivery: no currency
 * is ever worth nothing, so a 0 here always means nobody keyed it.
 */
export function resolveFxRate(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
