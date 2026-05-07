"use server";

import { db } from "@/db";
import { properties } from "@/db/schema";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { scrapeHar, type ParsedListing } from "@/lib/har-scraper";

export async function importHarAction(formData: FormData) {
  const rawUrl = String(formData.get("url") ?? "").trim();

  // Validate URL shape
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    redirect("/add/har?error=" + encodeURIComponent("Invalid URL — paste the full https://... address"));
  }
  if (!parsedUrl.hostname.includes("har.com")) {
    redirect("/add/har?error=" + encodeURIComponent("URL must be from har.com"));
  }

  // Fetch + parse (errors redirect back with a message)
  let parsed: ParsedListing;
  try {
    parsed = await scrapeHar(rawUrl);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Could not fetch the listing";
    redirect(
      `/add/har?error=${encodeURIComponent(msg)}&url=${encodeURIComponent(rawUrl)}`,
    );
  }

  // Require the three NOT NULL fields
  if (!parsed.priceCents) {
    redirect(
      `/add/har?error=${encodeURIComponent("Could not read the listing price — try the manual form")}&url=${encodeURIComponent(rawUrl)}`,
    );
  }
  if (!parsed.street) {
    redirect(
      `/add/har?error=${encodeURIComponent("Could not read the street address — try the manual form")}&url=${encodeURIComponent(rawUrl)}`,
    );
  }
  if (!parsed.zip) {
    redirect(
      `/add/har?error=${encodeURIComponent("Could not read the ZIP code — try the manual form")}&url=${encodeURIComponent(rawUrl)}`,
    );
  }

  const inserted = db
    .insert(properties)
    .values({
      addressStreet: parsed.street,
      addressCity: "Houston",
      addressZip: parsed.zip,
      beds: parsed.beds,
      baths: parsed.baths,
      sqft: parsed.sqft,
      yearBuilt: parsed.yearBuilt,
      listPriceCents: parsed.priceCents,
      source: "har",
      sourceUrl: rawUrl,
    })
    .returning()
    .get();

  revalidatePath("/");
  redirect(`/property/${inserted.id}`);
}
