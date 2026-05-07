"use server";

import { db } from "@/db";
import { properties, dealScores, rentEstimates, taxRecords } from "@/db/schema";
import { score } from "@/lib/scoring";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

function dollarsToCents(value: FormDataEntryValue | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function intOrNull(value: FormDataEntryValue | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function floatOrNull(value: FormDataEntryValue | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(value: FormDataEntryValue | null): string | null {
  const s = value == null ? "" : String(value).trim();
  return s === "" ? null : s;
}

export async function addPropertyAction(formData: FormData) {
  const street = String(formData.get("street") ?? "").trim();
  const city = String(formData.get("city") ?? "Houston").trim() || "Houston";
  const zip = String(formData.get("zip") ?? "").trim();
  const listPriceCents = dollarsToCents(formData.get("listPrice"));
  const rentCents = dollarsToCents(formData.get("rent"));

  if (!street || !zip || listPriceCents == null || rentCents == null) {
    throw new Error("Address, zip, list price, and estimated rent are required");
  }

  const beds = intOrNull(formData.get("beds"));
  const baths = floatOrNull(formData.get("baths"));
  const sqft = intOrNull(formData.get("sqft"));
  const yearBuilt = intOrNull(formData.get("yearBuilt"));
  const annualTaxCents = dollarsToCents(formData.get("annualTax"));
  const assessedValueCents = dollarsToCents(formData.get("assessedValue"));
  const sourceUrl = strOrNull(formData.get("sourceUrl"));
  const notes = strOrNull(formData.get("notes"));

  const inserted = db
    .insert(properties)
    .values({
      addressStreet: street,
      addressCity: city,
      addressZip: zip,
      beds,
      baths,
      sqft,
      yearBuilt,
      listPriceCents,
      source: "manual",
      sourceUrl,
      notes,
    })
    .returning()
    .get();

  db.insert(rentEstimates)
    .values({
      propertyId: inserted.id,
      estimatedRentCents: rentCents,
      method: "manual",
    })
    .run();

  if (annualTaxCents != null) {
    db.insert(taxRecords)
      .values({
        propertyId: inserted.id,
        assessedValueCents: assessedValueCents ?? listPriceCents,
        annualTaxCents,
      })
      .run();
  }

  const result = score({
    listPriceCents,
    monthlyRentCents: rentCents,
    annualTaxCentsOverride: annualTaxCents ?? undefined,
  });

  db.insert(dealScores)
    .values({
      propertyId: inserted.id,
      monthlyCashFlowCents: result.monthlyCashFlowCents,
      capRateBps: result.capRateBps,
      cashOnCashBps: result.cashOnCashBps,
      grossYieldBps: result.grossYieldBps,
      passesOnePct: result.passesOnePct,
      compositeScore: result.compositeScore,
      assumptionsJson: JSON.stringify(result.assumptions),
    })
    .run();

  revalidatePath("/");
  redirect(`/property/${inserted.id}`);
}
