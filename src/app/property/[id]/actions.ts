"use server";

import { db } from "@/db";
import { properties, rentEstimates, dealScores, taxRecords } from "@/db/schema";
import { score } from "@/lib/scoring";
import { scrapeHar } from "@/lib/har-scraper";
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

export async function updateListPriceAction(propertyId: number, formData: FormData) {
  const harUrl = String(formData.get("harUrl") ?? "").trim();
  const manualPriceStr = String(formData.get("manualPrice") ?? "").trim();

  let priceCents: number;
  let newSourceUrl: string | undefined;

  if (harUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(harUrl);
    } catch {
      redirect(
        `/property/${propertyId}?priceError=${encodeURIComponent("Invalid URL — paste the full https://... address")}`,
      );
    }
    if (!parsedUrl!.hostname.includes("har.com")) {
      redirect(
        `/property/${propertyId}?priceError=${encodeURIComponent("URL must be from har.com")}`,
      );
    }

    let parsed;
    try {
      parsed = await scrapeHar(harUrl);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Could not fetch the listing";
      redirect(`/property/${propertyId}?priceError=${encodeURIComponent(msg)}`);
    }

    if (!parsed!.priceCents) {
      redirect(
        `/property/${propertyId}?priceError=${encodeURIComponent("Could not read the price from HAR.com — enter manually instead")}`,
      );
    }
    priceCents = parsed!.priceCents;
    newSourceUrl = harUrl;
  } else {
    const dollars = parseFloat(manualPriceStr.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(dollars) || dollars <= 0) {
      redirect(
        `/property/${propertyId}?priceError=${encodeURIComponent("Enter a valid price or paste a HAR URL")}`,
      );
    }
    priceCents = Math.round(dollars * 100);
  }

  db.update(properties)
    .set({
      listPriceCents: priceCents,
      ...(newSourceUrl ? { sourceUrl: newSourceUrl } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(properties.id, propertyId))
    .run();

  // Re-score with updated price if a rent estimate exists
  const rent = db.select().from(rentEstimates).where(eq(rentEstimates.propertyId, propertyId)).get();
  if (rent) {
    const taxRow = db.select().from(taxRecords).where(eq(taxRecords.propertyId, propertyId)).get();
    const result = score({
      listPriceCents: priceCents,
      monthlyRentCents: rent.estimatedRentCents,
      annualTaxCentsOverride: taxRow?.annualTaxCents,
    });

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
  }

  revalidatePath("/");
  revalidatePath(`/property/${propertyId}`);
  redirect(`/property/${propertyId}`);
}
