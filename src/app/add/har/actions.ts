"use server";

import { db } from "@/db";
import { properties } from "@/db/schema";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface ParsedListing {
  priceCents: number | null;
  street: string | null;
  zip: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
}

function firstMatch(html: string, ...patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function metaContent(html: string, prop: string): string {
  return (
    firstMatch(
      html,
      new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]+)"`, "i"),
      new RegExp(`<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="${prop}"`, "i"),
    ) ?? ""
  );
}

function parsePrice(text: string): number | null {
  const m = text.match(/\$\s*([\d,]+)/);
  if (!m) return null;
  const d = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(d) && d > 10_000 && d < 10_000_000 ? d * 100 : null;
}

function parseBeds(text: string): number | null {
  const m = text.match(/(\d+)\s*(?:bed|br\b|bdrm|bedroom)/i);
  const n = m ? parseInt(m[1], 10) : null;
  return n !== null && n >= 1 && n <= 10 ? n : null;
}

function parseBaths(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba\b|bth)/i);
  const n = m ? parseFloat(m[1]) : null;
  return n !== null && n >= 1 && n <= 10 ? n : null;
}

function parseSqft(text: string): number | null {
  const m = text.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft)/i);
  const n = m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  return n !== null && n > 100 && n < 100_000 ? n : null;
}

function parseZip(text: string): string | null {
  const m = text.match(/\b(77\d{3})\b/);
  return m ? m[1] : null;
}

async function scrapeHar(url: string): Promise<ParsedListing> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from HAR.com`);
  const html = await res.text();

  let priceCents: number | null = null;
  let street: string | null = null;
  let zip: string | null = null;
  let beds: number | null = null;
  let baths: number | null = null;
  let sqft: number | null = null;
  let yearBuilt: number | null = null;

  // ── JSON-LD (most reliable when present) ──────────────────────────────────
  const ldBlocks = html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of ldBlocks) {
    try {
      const raw = JSON.parse(block[1]);
      const obj = Array.isArray(raw) ? raw[0] : raw;

      if (!priceCents) {
        const p = obj?.offers?.price ?? obj?.price;
        if (p != null) {
          const d = parseInt(String(p).replace(/[^0-9]/g, ""), 10);
          if (d > 10_000) priceCents = d * 100;
        }
      }

      const addr = obj?.address ?? obj?.geo;
      if (addr) {
        if (!street) street = addr.streetAddress ?? null;
        if (!zip) zip = addr.postalCode ? String(addr.postalCode) : null;
      }

      if (!beds) {
        const n = obj?.numberOfRooms ?? obj?.numberOfBedrooms;
        if (n != null) beds = parseInt(String(n), 10) || null;
      }
      if (!baths) {
        const n = obj?.numberOfBathroomsTotal ?? obj?.numberOfBathrooms;
        if (n != null) baths = parseFloat(String(n)) || null;
      }
      if (!sqft && obj?.floorSize?.value) {
        sqft = parseInt(String(obj.floorSize.value), 10) || null;
      }
      if (!yearBuilt && obj?.yearBuilt) {
        yearBuilt = parseInt(String(obj.yearBuilt), 10) || null;
      }
    } catch {
      // malformed JSON-LD — skip
    }
  }

  // ── Meta tags + title fallback ────────────────────────────────────────────
  const ogTitle = metaContent(html, "og:title");
  const ogDesc = metaContent(html, "og:description");
  const pageTitle = firstMatch(html, /<title[^>]*>([^<]+)<\/title>/i) ?? "";

  // HAR og:title is often "STREET, Houston, TX 77XXX" — grab street from it
  if (!street && ogTitle) {
    const m = ogTitle.match(/^([^,]+)/);
    if (m) street = m[1].trim();
  }

  // Soup all text sources for remaining fields
  const soup = `${ogTitle} ${ogDesc} ${pageTitle}`;
  if (!priceCents) priceCents = parsePrice(soup);
  if (!zip) zip = parseZip(soup);
  if (!beds) beds = parseBeds(soup);
  if (!baths) baths = parseBaths(soup);
  if (!sqft) sqft = parseSqft(soup);

  // Year built sometimes lives in body text only
  if (!yearBuilt) {
    const m = html.match(/(?:year\s*built|built\s*in)[:\s]+(\d{4})/i);
    if (m) yearBuilt = parseInt(m[1], 10);
  }

  return { priceCents, street, zip, beds, baths, sqft, yearBuilt };
}

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
