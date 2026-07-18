import { describe, it, expect } from "vitest";
import {
  draftMethodFields,
  missingMethodSubField,
  parseInstallmentMonths,
} from "./PaymentsTable";

/**
 * Installment gains a Bank picker (owner 2026-07-19 "Installment 要能选银行的").
 * The bank drives the EPP/installment fee, so the row must now carry
 * merchant_provider just like Merchant does — while Merchant, Cash and Online
 * stay exactly as they were. draftMethodFields is the ONE place the per-method
 * payload is derived (shared by the desktop commit + every draft-batching page),
 * so pinning it here proves the change reaches every surface.
 */
describe("draftMethodFields — installment carries the bank", () => {
  it("installment sends BOTH the bank (merchant_provider) and the plan", () => {
    expect(
      draftMethodFields("installment", {
        merchantProvider: "CIMB",
        installmentMonthsLabel: "12 months",
        onlineType: "",
      }),
    ).toEqual({ merchantProvider: "CIMB", installmentMonths: 12 });
  });

  it("installment with no bank picked persists a null bank (optional, still books)", () => {
    expect(
      draftMethodFields("installment", {
        merchantProvider: "",
        installmentMonthsLabel: "6 months",
        onlineType: "",
      }),
    ).toEqual({ merchantProvider: null, installmentMonths: 6 });
  });

  it("merchant is unchanged — bank + plan, same as before", () => {
    expect(
      draftMethodFields("merchant", {
        merchantProvider: "MBB",
        installmentMonthsLabel: "One Shot",
        onlineType: "",
      }),
    ).toEqual({ merchantProvider: "MBB", installmentMonths: null });
  });

  it("cash carries no bank", () => {
    expect(
      draftMethodFields("cash", {
        merchantProvider: "MBB",
        installmentMonthsLabel: "12 months",
        onlineType: "TNG",
      }),
    ).toEqual({});
  });

  it("online (transfer) carries no bank — only its sub-type", () => {
    expect(
      draftMethodFields("transfer", {
        merchantProvider: "MBB",
        installmentMonthsLabel: "12 months",
        onlineType: "TNG",
      }),
    ).toEqual({ onlineType: "TNG" });
  });
});

describe("missingMethodSubField — the Installment bank is OPTIONAL (not gated)", () => {
  it("installment with neither bank nor plan is still allowed to book", () => {
    expect(
      missingMethodSubField({
        methodLabel: "Installment",
        merchantProvider: "",
        installmentMonthsLabel: "",
        onlineType: "",
      }),
    ).toBeNull();
  });

  it("merchant still REQUIRES the bank (unchanged)", () => {
    expect(
      missingMethodSubField({
        methodLabel: "Merchant",
        merchantProvider: "",
        installmentMonthsLabel: "12 months",
        onlineType: "",
      }),
    ).toBe("Bank");
  });
});

describe("parseInstallmentMonths", () => {
  it("parses an N-month plan to its integer term", () => {
    expect(parseInstallmentMonths("12 months")).toBe(12);
  });
  it("treats the one-shot labels as no installment", () => {
    expect(parseInstallmentMonths("One Shot")).toBeNull();
    expect(parseInstallmentMonths("One-off")).toBeNull();
    expect(parseInstallmentMonths("")).toBeNull();
  });
});
