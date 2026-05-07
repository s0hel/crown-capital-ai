#!/usr/bin/env node
/**
 * Score Properties
 *
 * Assigns rent estimates and deal scores to HCAD-imported properties that
 * have rent_comps data but no deal_score yet.
 *
 * Rent lookup order:
 *   1. Zip + beds exact match → median of comps (requires ≥ MIN_COMPS)
 *   2. Houston-wide + beds → median of all Houston comps for that bed count
 *   3. HUD Fair Market Rent (hardcoded 2025 floor for Harris County)
 *
 * Usage:
 *   node scripts/score-properties.mjs
 *   node scripts/score-properties.mjs --rescore       # rescore even if already scored
 *   node scripts/score-properties.mjs --limit 5000    # stop after N properties
 *   node scripts/score-properties.mjs --dry-run       # compute but don't write
 */

import Database from "better-sqlite3";

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const RESCORE = hasFlag("--rescore");
const DRY_RUN = hasFlag("--dry-run");
const LIMIT = parseInt(getArg("--limit", "0"), 10);
const MIN_COMPS = 3; // minimum comps for a zip-specific median

// ── HUD Fair Market Rents — Harris County / Houston Metro (FY2025 floor) ───
// Source: HUD.gov. These are 40th-percentile rents; actual market rents are
// typically 15-25% above FMR in Houston. Used only as last-resort fallback.
const HUD_FMR = {
  0: 114_600, // studio → $1,146/mo (cents)
  1: 127_700, // 1-bed
  2: 150_100, // 2-bed
  3: 196_900, // 3-bed
  4: 228_000, // 4-bed
};

// ── SCORING ENGINE (inline, avoids TS import) ─────────────────────────────
// Mirrors src/lib/scoring.ts exactly. Keep in sync if defaults change.
const HOUSTON_DEFAULTS = {
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

function monthlyMortgage(principalCents, ratePct, termYears) {
  if (principalCents <= 0) return 0;
  const r = ratePct / 100 / 12;
  const n = termYears * 12;
  if (r === 0) return Math.round(principalCents / n);
  return Math.round(
    (principalCents * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1),
  );
}

function computeScore({ priceCents, rentCents, annualTaxCents }) {
  const a = HOUSTON_DEFAULTS;
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
  const capBps = priceCents > 0 ? Math.round((noi / priceCents) * 10_000) : 0;
  const cocBps =
    cashRequired > 0 ? Math.round(((cashFlow * 12) / cashRequired) * 10_000) : 0;
  const grossBps = priceCents > 0 ? Math.round(((rentCents * 12) / priceCents) * 10_000) : 0;
  const passesOnePct = rentCents * 100 >= priceCents;
  const cocComp = Math.max(0, Math.min(40, (cocBps / 100) * 4));
  const capComp = Math.max(0, Math.min(30, (capBps / 100) * 3));
  const cashFlowComp = cashFlow > 0 ? 20 : cashFlow < 0 ? -20 : 0;
  const onePctBonus = passesOnePct ? 10 : 0;
  const composite = Math.max(0, Math.min(100, cocComp + capComp + cashFlowComp + onePctBonus));
  return { cashFlow, capBps, cocBps, grossBps, passesOnePct, composite };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

function main() {
  console.log("Score Properties");
  if (DRY_RUN) console.log("  (dry run — no DB writes)");
  if (RESCORE) console.log("  (--rescore: will overwrite existing scores)");

  const db = new Database(process.env.DB_PATH ?? "./data.db", { timeout: 30000 });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Build rent lookup table from comps ───────────────────────────────────

  console.log("\nBuilding rent lookup from comps...");
  // zip|beds → sorted array of cents (for median)
  const compsByZipBeds = new Map();
  const compsByBeds = new Map(); // Houston-wide: beds → sorted array

  const comps = db
    .prepare(
      "SELECT zip, beds, asking_rent_cents FROM rent_comps WHERE beds IS NOT NULL AND asking_rent_cents > 0",
    )
    .all();

  for (const { zip, beds, asking_rent_cents } of comps) {
    if (beds < 1 || beds > 6) continue;
    // Houston-wide bucket
    if (!compsByBeds.has(beds)) compsByBeds.set(beds, []);
    compsByBeds.get(beds).push(asking_rent_cents);
    // Zip+beds bucket
    if (zip) {
      const key = `${zip}|${beds}`;
      if (!compsByZipBeds.has(key)) compsByZipBeds.set(key, []);
      compsByZipBeds.get(key).push(asking_rent_cents);
    }
  }

  // Sort each bucket for median calculation
  for (const arr of compsByZipBeds.values()) arr.sort((a, b) => a - b);
  for (const arr of compsByBeds.values()) arr.sort((a, b) => a - b);

  function median(arr) {
    if (!arr || arr.length === 0) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0
      ? Math.round((arr[mid - 1] + arr[mid]) / 2)
      : arr[mid];
  }

  function getRentEstimate(zip, beds) {
    // 1. Zip + beds exact match
    const key = `${zip}|${beds}`;
    const zipComps = compsByZipBeds.get(key) ?? [];
    if (zipComps.length >= MIN_COMPS) {
      return { rentCents: median(zipComps), method: "comps-zip", sampleSize: zipComps.length };
    }
    // 2. Houston-wide by beds
    const houstonComps = compsByBeds.get(beds) ?? [];
    if (houstonComps.length > 0) {
      return { rentCents: median(houstonComps), method: "comps-houston", sampleSize: houstonComps.length };
    }
    // 3. HUD FMR floor — use beds capped at 4
    const fmrBeds = Math.min(beds, 4);
    const fmrCents = HUD_FMR[fmrBeds] ?? HUD_FMR[4];
    return { rentCents: fmrCents, method: "hud-fmr", sampleSize: 0 };
  }

  console.log("  Comp buckets:");
  for (const [beds, arr] of [...compsByBeds.entries()].sort()) {
    console.log(
      `    ${beds}-bed: ${arr.length} comps, median $${Math.round(median(arr) / 100).toLocaleString()}/mo`,
    );
  }
  console.log(`  Zip+bed buckets with ≥${MIN_COMPS} comps: ${[...compsByZipBeds.values()].filter((a) => a.length >= MIN_COMPS).length}`);

  // ── Load properties to score ─────────────────────────────────────────────

  const query = RESCORE
    ? `SELECT p.id, p.address_zip as zip, p.beds, p.list_price_cents,
              t.annual_tax_cents
       FROM properties p
       LEFT JOIN tax_records t ON t.property_id = p.id
       WHERE p.status = 'active' AND p.beds IS NOT NULL AND p.beds > 0
         AND p.list_price_cents > 0
       ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ""}`
    : `SELECT p.id, p.address_zip as zip, p.beds, p.list_price_cents,
              t.annual_tax_cents
       FROM properties p
       LEFT JOIN tax_records t ON t.property_id = p.id
       LEFT JOIN deal_scores ds ON ds.property_id = p.id
       WHERE p.status = 'active' AND p.beds IS NOT NULL AND p.beds > 0
         AND p.list_price_cents > 0
         AND ds.id IS NULL
       ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ""}`;

  const properties = db.prepare(query).all();
  console.log(`\nProperties to score: ${properties.length.toLocaleString()}`);

  if (properties.length === 0) {
    console.log("  Nothing to score. Run craigslist-comps.mjs first or add --rescore.");
    db.close();
    return;
  }

  // ── Score in batches ─────────────────────────────────────────────────────

  const deleteRent = db.prepare("DELETE FROM rent_estimates WHERE property_id = ? AND method != 'manual'");
  const insertRent = db.prepare(
    "INSERT INTO rent_estimates (property_id, estimated_rent_cents, method, sample_size) VALUES (?, ?, ?, ?)",
  );
  const deleteScore = db.prepare("DELETE FROM deal_scores WHERE property_id = ?");
  const insertScore = db.prepare(`
    INSERT INTO deal_scores (property_id, monthly_cash_flow_cents, cap_rate_bps,
      cash_on_cash_bps, gross_yield_bps, passes_one_pct, composite_score, assumptions_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const methodCounts = { "comps-zip": 0, "comps-houston": 0, "hud-fmr": 0, skipped: 0 };
  let processedCount = 0;
  const BATCH_SIZE = 200;

  const batchProcess = db.transaction((batch) => {
    for (const prop of batch) {
      const rentResult = getRentEstimate(prop.zip, prop.beds);
      if (!rentResult) {
        methodCounts.skipped++;
        continue;
      }
      const { rentCents, method, sampleSize } = rentResult;
      const scoreResult = computeScore({
        priceCents: prop.list_price_cents,
        rentCents,
        annualTaxCents: prop.annual_tax_cents,
      });

      if (!DRY_RUN) {
        deleteRent.run(prop.id);
        insertRent.run(prop.id, rentCents, method, sampleSize);
        if (RESCORE) deleteScore.run(prop.id);
        insertScore.run(
          prop.id,
          scoreResult.cashFlow,
          scoreResult.capBps,
          scoreResult.cocBps,
          scoreResult.grossBps,
          scoreResult.passesOnePct ? 1 : 0,
          scoreResult.composite,
          JSON.stringify(HOUSTON_DEFAULTS),
        );
      }
      methodCounts[method]++;
      processedCount++;
    }
  });

  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE);
    batchProcess(batch);
    if (i % 5000 === 0 || i + BATCH_SIZE >= properties.length) {
      process.stdout.write(
        `\r  Processed ${Math.min(i + BATCH_SIZE, properties.length).toLocaleString()} / ${properties.length.toLocaleString()}   `,
      );
    }
  }
  console.log();

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n── Results ─────────────────────────────────────────");
  console.log(`  Scored              : ${processedCount.toLocaleString()}`);
  console.log(`  By zip+beds comps   : ${methodCounts["comps-zip"].toLocaleString()}`);
  console.log(`  By Houston comps    : ${methodCounts["comps-houston"].toLocaleString()}`);
  console.log(`  By HUD FMR (floor)  : ${methodCounts["hud-fmr"].toLocaleString()}`);
  if (methodCounts.skipped > 0) {
    console.log(`  Skipped (no rent)   : ${methodCounts.skipped.toLocaleString()}`);
  }

  if (!DRY_RUN) {
    const topDeals = db
      .prepare(
        `SELECT p.address_street, p.address_zip, p.beds, p.list_price_cents,
                ds.composite_score, ds.monthly_cash_flow_cents, ds.cap_rate_bps
         FROM deal_scores ds
         JOIN properties p ON p.id = ds.property_id
         WHERE ds.composite_score >= 50
         ORDER BY ds.composite_score DESC
         LIMIT 10`,
      )
      .all();

    if (topDeals.length > 0) {
      console.log("\n  Top deals (score ≥ 50):");
      for (const d of topDeals) {
        const cashFlow = (d.monthly_cash_flow_cents / 100).toFixed(0);
        const capRate = (d.cap_rate_bps / 100).toFixed(1);
        const price = (d.list_price_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
        console.log(
          `    [${Math.round(d.composite_score)}] ${d.address_street} (${d.address_zip}) ${d.beds}bd — ${price} — $${cashFlow}/mo CF, ${capRate}% cap`,
        );
      }
    }
    console.log("\n  Open http://localhost:3000 to browse all scored leads.");
  }

  db.close();
}

main();
