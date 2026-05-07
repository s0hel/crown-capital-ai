"use server";

import { db } from "@/db";
import { properties, rentEstimates, dealScores, taxRecords } from "@/db/schema";
import { score } from "@/lib/scoring";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function addRentEstimateAction(propertyId: number, formData: FormData) {
  const rentDollars = parseFloat(String(formData.get("rent") ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(rentDollars) || rentDollars <= 0) {
    throw new Error("Invalid rent amount");
  }
  const monthlyRentCents = Math.round(rentDollars * 100);

  const property = db.select().from(properties).where(eq(properties.id, propertyId)).get();
  if (!property) throw new Error("Property not found");

  const taxRow = db.select().from(taxRecords).where(eq(taxRecords.propertyId, propertyId)).get();

  // Upsert rent estimate (replace existing)
  db.delete(rentEstimates).where(eq(rentEstimates.propertyId, propertyId)).run();
  db.insert(rentEstimates)
    .values({ propertyId, estimatedRentCents: monthlyRentCents, method: "manual" })
    .run();

  // Score
  const result = score({
    listPriceCents: property.listPriceCents,
    monthlyRentCents,
    annualTaxCentsOverride: taxRow?.annualTaxCents,
  });

  // Upsert deal score
  db.delete(dealScores).where(eq(dealScores.propertyId, propertyId)).run();
  db.insert(dealScores)
    .values({
      propertyId,
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
  revalidatePath(`/property/${propertyId}`);
  redirect(`/property/${propertyId}`);
}
