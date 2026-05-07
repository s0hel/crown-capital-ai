// Seeds two example Houston properties so the leads page has something to show.
// Run: node scripts/seed.mjs
import Database from "better-sqlite3";

const db = new Database("./data.db");
db.pragma("foreign_keys = ON");

function dollarsToCents(d) {
  return Math.round(d * 100);
}

function monthlyMortgage(principalCents, annualRatePct, termYears) {
  const r = annualRatePct / 100 / 12;
  const n = termYears * 12;
  if (r === 0) return Math.round(principalCents / n);
  return Math.round((principalCents * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
}

function score({ priceCents, rentCents, annualTaxCents }) {
  const a = {
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
  const down = Math.round(priceCents * (a.downPaymentPct / 100));
  const loan = priceCents - down;
  const closing = Math.round(priceCents * (a.closingCostPct / 100));
  const cashRequired = down + closing;
  const mortgage = monthlyMortgage(loan, a.mortgageRatePct, a.loanTermYears);
  const tax = annualTaxCents ?? Math.round(priceCents * (a.annualTaxRatePct / 100));
  const monthlyTax = Math.round(tax / 12);
  const monthlyInsurance = Math.round(a.annualInsuranceCents / 12);
  const vacancy = Math.round(rentCents * (a.vacancyPct / 100));
  const maintenance = Math.round(rentCents * (a.maintenancePct / 100));
  const opex = monthlyTax + monthlyInsurance + vacancy + maintenance;
  const cashFlow = rentCents - mortgage - opex;
  const noi = (rentCents - opex) * 12;
  const capBps = Math.round((noi / priceCents) * 10_000);
  const cocBps = Math.round(((cashFlow * 12) / cashRequired) * 10_000);
  const grossBps = Math.round(((rentCents * 12) / priceCents) * 10_000);
  const passesOnePct = rentCents * 100 >= priceCents;
  const cocComp = Math.max(0, Math.min(40, (cocBps / 100) * 4));
  const capComp = Math.max(0, Math.min(30, (capBps / 100) * 3));
  const cashFlowComp = cashFlow > 0 ? 20 : cashFlow < 0 ? -20 : 0;
  const onePctBonus = passesOnePct ? 10 : 0;
  const composite = Math.max(0, Math.min(100, cocComp + capComp + cashFlowComp + onePctBonus));
  return {
    cashFlow,
    capBps,
    cocBps,
    grossBps,
    passesOnePct,
    composite,
    assumptions: a,
  };
}

const samples = [
  {
    addressStreet: "5412 Heatherbrook Dr",
    addressZip: "77091",
    beds: 3,
    baths: 2,
    sqft: 1450,
    yearBuilt: 1965,
    listPriceCents: dollarsToCents(165000),
    rentCents: dollarsToCents(1750),
    assessedValueCents: dollarsToCents(148000),
    annualTaxCents: dollarsToCents(3850),
    absenteeOwner: true,
    floodZone: "X",
    notes: "Acres Homes — owner mailing in San Antonio. Estate sale per listing.",
  },
  {
    addressStreet: "8120 Park Pl Blvd",
    addressZip: "77017",
    beds: 4,
    baths: 2,
    sqft: 1820,
    yearBuilt: 1958,
    listPriceCents: dollarsToCents(225000),
    rentCents: dollarsToCents(2100),
    assessedValueCents: dollarsToCents(210000),
    annualTaxCents: dollarsToCents(5400),
    absenteeOwner: false,
    floodZone: "AE",
    notes: "Park Place — flood zone AE, Harvey-impacted area.",
  },
];

const insertProperty = db.prepare(`
  INSERT INTO properties (address_street, address_city, address_zip, beds, baths, sqft, year_built,
    list_price_cents, source, source_url, absentee_owner, flood_zone, notes)
  VALUES (@addressStreet, 'Houston', @addressZip, @beds, @baths, @sqft, @yearBuilt,
    @listPriceCents, 'manual', NULL, @absenteeOwner, @floodZone, @notes)
`);

const insertRent = db.prepare(`
  INSERT INTO rent_estimates (property_id, estimated_rent_cents, method)
  VALUES (?, ?, 'manual')
`);

const insertTax = db.prepare(`
  INSERT INTO tax_records (property_id, assessed_value_cents, annual_tax_cents)
  VALUES (?, ?, ?)
`);

const insertScore = db.prepare(`
  INSERT INTO deal_scores (property_id, monthly_cash_flow_cents, cap_rate_bps, cash_on_cash_bps,
    gross_yield_bps, passes_one_pct, composite_score, assumptions_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const tx = db.transaction((rows) => {
  for (const r of rows) {
    const result = insertProperty.run({
      ...r,
      absenteeOwner: r.absenteeOwner ? 1 : 0,
    });
    const id = result.lastInsertRowid;
    insertRent.run(id, r.rentCents);
    insertTax.run(id, r.assessedValueCents, r.annualTaxCents);
    const s = score({
      priceCents: r.listPriceCents,
      rentCents: r.rentCents,
      annualTaxCents: r.annualTaxCents,
    });
    insertScore.run(
      id,
      s.cashFlow,
      s.capBps,
      s.cocBps,
      s.grossBps,
      s.passesOnePct ? 1 : 0,
      s.composite,
      JSON.stringify(s.assumptions),
    );
    console.log(
      `seeded #${id} ${r.addressStreet} — score ${s.composite.toFixed(0)}, cash flow ${(s.cashFlow / 100).toFixed(0)}/mo`,
    );
  }
});

tx(samples);
db.close();
console.log("done.");
