export type Assumptions = {
  downPaymentPct: number;
  mortgageRatePct: number;
  loanTermYears: number;
  vacancyPct: number;
  maintenancePct: number;
  propertyMgmtPct: number;
  closingCostPct: number;
  annualInsuranceCents: number;
  annualTaxRatePct: number;
};

// Houston / Harris County baseline. Tax rate is the effective combined rate
// (county + city + ISD + MUD) — varies a lot by district; 2.3% is a reasonable
// blended default. Insurance is high vs national norms because of windstorm +
// flood + general TX rates.
export const HOUSTON_DEFAULTS: Assumptions = {
  downPaymentPct: 25,
  mortgageRatePct: 7.0,
  loanTermYears: 30,
  vacancyPct: 8,
  maintenancePct: 10,
  propertyMgmtPct: 0,
  closingCostPct: 3,
  annualInsuranceCents: 280_000,
  annualTaxRatePct: 2.3,
};

export type ScoringInput = {
  listPriceCents: number;
  monthlyRentCents: number;
  annualTaxCentsOverride?: number;
  annualInsuranceCentsOverride?: number;
  assumptions?: Partial<Assumptions>;
};

export type ScoringResult = {
  monthlyCashFlowCents: number;
  monthlyMortgageCents: number;
  monthlyTaxCents: number;
  monthlyInsuranceCents: number;
  monthlyVacancyCents: number;
  monthlyMaintenanceCents: number;
  monthlyMgmtCents: number;
  noiAnnualCents: number;
  capRateBps: number;
  cashOnCashBps: number;
  grossYieldBps: number;
  passesOnePct: boolean;
  cashRequiredCents: number;
  compositeScore: number;
  assumptions: Assumptions;
};

function monthlyMortgagePayment(
  principalCents: number,
  annualRatePct: number,
  termYears: number,
): number {
  if (principalCents <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  const n = termYears * 12;
  if (r === 0) return Math.round(principalCents / n);
  const factor = (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  return Math.round(principalCents * factor);
}

export function score(input: ScoringInput): ScoringResult {
  const a: Assumptions = { ...HOUSTON_DEFAULTS, ...(input.assumptions ?? {}) };
  const price = input.listPriceCents;
  const rent = input.monthlyRentCents;

  const downPaymentCents = Math.round(price * (a.downPaymentPct / 100));
  const loanCents = price - downPaymentCents;
  const closingCostCents = Math.round(price * (a.closingCostPct / 100));
  const cashRequiredCents = downPaymentCents + closingCostCents;

  const monthlyMortgageCents = monthlyMortgagePayment(
    loanCents,
    a.mortgageRatePct,
    a.loanTermYears,
  );

  const annualTaxCents =
    input.annualTaxCentsOverride ?? Math.round(price * (a.annualTaxRatePct / 100));
  const monthlyTaxCents = Math.round(annualTaxCents / 12);

  const annualInsuranceCents = input.annualInsuranceCentsOverride ?? a.annualInsuranceCents;
  const monthlyInsuranceCents = Math.round(annualInsuranceCents / 12);

  const monthlyVacancyCents = Math.round(rent * (a.vacancyPct / 100));
  const monthlyMaintenanceCents = Math.round(rent * (a.maintenancePct / 100));
  const monthlyMgmtCents = Math.round(rent * (a.propertyMgmtPct / 100));

  const monthlyOperatingExpensesCents =
    monthlyTaxCents +
    monthlyInsuranceCents +
    monthlyVacancyCents +
    monthlyMaintenanceCents +
    monthlyMgmtCents;

  const monthlyCashFlowCents = rent - monthlyMortgageCents - monthlyOperatingExpensesCents;

  // NOI excludes financing — used for cap rate.
  const monthlyNoiCents = rent - monthlyOperatingExpensesCents;
  const noiAnnualCents = monthlyNoiCents * 12;

  const capRateBps = price > 0 ? Math.round((noiAnnualCents / price) * 10_000) : 0;
  const cashOnCashBps =
    cashRequiredCents > 0
      ? Math.round(((monthlyCashFlowCents * 12) / cashRequiredCents) * 10_000)
      : 0;
  const grossYieldBps = price > 0 ? Math.round(((rent * 12) / price) * 10_000) : 0;

  const passesOnePct = rent * 100 >= price;

  // Composite 0-100. Weighted blend favoring cash-on-cash, then cap rate, then
  // a one-percent-rule bonus. Clamped so a single great metric doesn't mask a
  // negative-cash-flow deal.
  const cocComponent = Math.max(0, Math.min(40, (cashOnCashBps / 100) * 4));
  const capComponent = Math.max(0, Math.min(30, (capRateBps / 100) * 3));
  const cashFlowComponent = monthlyCashFlowCents > 0 ? 20 : monthlyCashFlowCents < 0 ? -20 : 0;
  const onePctBonus = passesOnePct ? 10 : 0;
  const compositeScore = Math.max(
    0,
    Math.min(100, cocComponent + capComponent + cashFlowComponent + onePctBonus),
  );

  return {
    monthlyCashFlowCents,
    monthlyMortgageCents,
    monthlyTaxCents,
    monthlyInsuranceCents,
    monthlyVacancyCents,
    monthlyMaintenanceCents,
    monthlyMgmtCents,
    noiAnnualCents,
    capRateBps,
    cashOnCashBps,
    grossYieldBps,
    passesOnePct,
    cashRequiredCents,
    compositeScore,
    assumptions: a,
  };
}

export function fmtMoney(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function fmtMoneyDetailed(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtPctFromBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
