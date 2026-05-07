#!/usr/bin/env node
/**
 * Craigslist Houston FSBO Scraper
 *
 * Scrapes for-sale real estate listings from houston.craigslist.org/search/rea
 * and inserts them as properties with source='craigslist-fsbo'. These carry
 * real asking prices rather than HCAD appraisal proxies.
 *
 * Two-pass approach (mirrors craigslist-comps.mjs):
 *   Pass 1 — General Houston search, one request per bed count
 *   Pass 2 — Per-zip search for top N zips by HCAD property density
 *
 * Deduplication: source_url is the natural key — existing URLs are skipped.
 * Re-running accumulates new listings; it won't update changed prices.
 *
 * Usage:
 *   node scripts/craigslist-fsbo.mjs
 *   node scripts/craigslist-fsbo.mjs --general-only
 *   node scripts/craigslist-fsbo.mjs --top-zips 30
 *   node scripts/craigslist-fsbo.mjs --beds 3
 *   node scripts/craigslist-fsbo.mjs --dry-run
 *
 * After running:
 *   node scripts/score-properties.mjs   # scores new unscored properties
 */

import Database from "better-sqlite3";

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const GENERAL_ONLY = hasFlag("--general-only");
const DRY_RUN = hasFlag("--dry-run");
const TOP_ZIPS = parseInt(getArg("--top-zips", "50"), 10);
const BEDS_FILTER = getArg("--beds", null);
const BED_COUNTS = BEDS_FILTER ? [parseInt(BEDS_FILTER, 10)] : [1, 2, 3, 4];

const MIN_PRICE = 50_000;
const MAX_PRICE = 600_000;
const DELAY_MIN = 2000;
const DELAY_MAX = 4000;
const BASE_URL = "https://houston.craigslist.org";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── COOKIE JAR ───────────────────────────────────────────────────────────────

let cookieJar = "";

function updateCookies(res) {
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [];
  for (const cookie of setCookies) {
    const kv = cookie.split(";")[0].trim();
    const name = kv.split("=")[0];
    if (cookieJar.includes(name + "=")) {
      cookieJar = cookieJar.replace(new RegExp(`${name}=[^;]*(; )?`), "");
    }
    cookieJar = cookieJar ? `${cookieJar}; ${kv}` : kv;
  }
}

async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
  });
  updateCookies(res);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function politeDelay() {
  const ms = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
  await new Promise((r) => setTimeout(r, ms));
}

// ── HTML PARSING ─────────────────────────────────────────────────────────────

function htmlDecode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Parse Craigslist real estate search result HTML.
 * Returns an array of property objects.
 *
 * knownBeds: pass when searching by bed count (min_bedrooms=N&max_bedrooms=N),
 *            null when searching without a bed filter.
 * knownZip:  pass when doing a postal= search so all results get that zip.
 */
function parseListings(html, knownBeds, knownZip) {
  const results = [];
  const blockRe = /class="cl-static-search-result"[^>]*title="([^"]*)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="price">\s*(\$[\d,]+)\s*<\/div>[\s\S]*?<div class="location">\s*([^<]*?)\s*<\/div>[\s\S]*?<\/li>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const title = htmlDecode(m[1]);
    const href = m[2];
    const priceStr = m[3].replace(/[$,]/g, "");
    const location = htmlDecode(m[4].trim());

    const priceDollars = parseInt(priceStr, 10);
    if (!priceDollars || priceDollars < MIN_PRICE || priceDollars > MAX_PRICE) continue;

    const sourceUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

    // Zip: prefer known (from postal= search), then extract from text
    let zip = knownZip ?? null;
    if (!zip) {
      const zipMatch = (title + " " + location).match(/\b(77\d{3})\b/);
      zip = zipMatch ? zipMatch[1] : null;
    }

    // Beds
    let beds = knownBeds ?? null;
    if (!beds) {
      const bedsMatch = title.match(/(\d+)\s*(?:bed|br\b|bdrm|bedroom)/i);
      beds = bedsMatch ? parseInt(bedsMatch[1], 10) : null;
    }
    if (beds !== null && (beds < 1 || beds > 6)) continue;

    // Baths
    const bathsMatch = title.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba\b|bth)/i);
    const baths = bathsMatch ? parseFloat(bathsMatch[1]) : null;

    // Sqft
    const sqftMatch = title.match(/(\d{3,4})\s*(?:sq\.?\s*ft|sqft)/i);
    const sqft = sqftMatch ? parseInt(sqftMatch[1], 10) : null;

    // Street address: try to extract from title, else fall back to truncated title
    const addrMatch = title.match(/\d+\s+\w[\w\s]{2,30}(?:St|Ave|Blvd|Dr|Ln|Rd|Way|Ct|Pl|Cir|Loop|Fwy|Pkwy|Hwy)\b/i);
    const addressStreet = addrMatch ? addrMatch[0].trim() : title.slice(0, 100);

    // Drop obvious outliers
    if (/\b(beaumont|conroe|galveston|angleton|bay city)\b/i.test(location)) continue;

    results.push({ priceDollars, sourceUrl, zip, beds, baths, sqft, addressStreet });
  }
  return results;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Craigslist Houston FSBO Scraper");
  if (DRY_RUN) console.log("  (dry run — no DB writes)");
  console.log(`  Bed counts  : ${BED_COUNTS.join(", ")}`);
  console.log(`  Price range : $${(MIN_PRICE / 1000).toFixed(0)}K – $${(MAX_PRICE / 1000).toFixed(0)}K`);

  const db = new Database(process.env.DB_PATH ?? "./data.db", { timeout: 30000 });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Load existing source URLs for deduplication
  const existingUrls = new Set(
    db
      .prepare("SELECT source_url FROM properties WHERE source = 'craigslist-fsbo' AND source_url IS NOT NULL")
      .all()
      .map((r) => r.source_url),
  );
  console.log(`  Existing FSBO listings: ${existingUrls.size}`);

  const insertProp = db.prepare(`
    INSERT INTO properties
      (hcad_account, address_street, address_city, address_zip,
       beds, baths, sqft, list_price_cents, source, source_url, status)
    VALUES
      (NULL, @addressStreet, 'Houston', @zip,
       @beds, @baths, @sqft, @listPriceCents, 'craigslist-fsbo', @sourceUrl, 'active')
  `);

  const batchInsert = db.transaction((rows) => {
    let n = 0;
    for (const row of rows) {
      if (existingUrls.has(row.sourceUrl)) continue;
      insertProp.run(row);
      existingUrls.add(row.sourceUrl);
      n++;
    }
    return n;
  });

  let totalFetched = 0;
  let totalInserted = 0;

  // ── Seed cookie ───────────────────────────────────────────────────────────

  console.log("\nStep 1: Getting session cookie...");
  try {
    await fetchPage(`${BASE_URL}/`);
    console.log(`  ✓ Cookie: ${cookieJar.slice(0, 60)}...`);
  } catch (e) {
    console.warn("  ⚠ Could not seed cookie:", e.message);
  }
  await politeDelay();

  // ── Pass 1: General Houston search ────────────────────────────────────────

  console.log("\nStep 2: General Houston search");

  for (const beds of BED_COUNTS) {
    const url = `${BASE_URL}/search/rea?min_bedrooms=${beds}&max_bedrooms=${beds}&min_price=${MIN_PRICE}&max_price=${MAX_PRICE}`;
    process.stdout.write(`  ${beds}-bed... `);
    try {
      const html = await fetchPage(url);
      const listings = parseListings(html, beds, null);
      totalFetched += listings.length;

      const toInsert = listings.map((l) => ({
        addressStreet: l.addressStreet,
        zip: l.zip,
        beds: l.beds,
        baths: l.baths,
        sqft: l.sqft,
        listPriceCents: l.priceDollars * 100,
        sourceUrl: l.sourceUrl,
      }));

      // General search: skip listings without a zip (address_zip is NOT NULL).
      // Per-zip pass assigns the searched zip to all results, so little is lost here.
      const toInsertWithZip = toInsert.filter((r) => r.zip);

      if (!DRY_RUN) {
        const n = batchInsert(toInsertWithZip);
        totalInserted += n;
        console.log(`${listings.length} parsed, ${n} new saved (${toInsertWithZip.length} had zip)`);
      } else {
        console.log(`${listings.length} parsed (dry run, ${toInsertWithZip.length} have zip)`);
        if (toInsertWithZip.length > 0) {
          const s = toInsertWithZip[0];
          console.log(`    sample: "${s.addressStreet}" — $${s.listPriceCents / 100}, ${s.beds}bd`);
        }
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
    await politeDelay();
  }

  // ── Pass 2: Per-zip search ────────────────────────────────────────────────

  if (!GENERAL_ONLY) {
    console.log(`\nStep 3: Per-zip search (top ${TOP_ZIPS} zips by HCAD density)`);

    const topZips = db
      .prepare(
        `SELECT address_zip as zip, COUNT(*) as cnt
         FROM properties
         WHERE source = 'hcad-import' AND address_zip IS NOT NULL
         GROUP BY address_zip
         ORDER BY cnt DESC
         LIMIT ?`,
      )
      .all(TOP_ZIPS)
      .map((r) => r.zip);

    console.log(`  Found ${topZips.length} target zips`);

    let zipsDone = 0;
    for (const zip of topZips) {
      zipsDone++;
      process.stdout.write(`  [${zipsDone}/${topZips.length}] zip ${zip}: `);

      const zipListings = [];
      for (const beds of BED_COUNTS) {
        const url = `${BASE_URL}/search/rea?min_bedrooms=${beds}&max_bedrooms=${beds}&min_price=${MIN_PRICE}&max_price=${MAX_PRICE}&postal=${zip}&search_distance=2`;
        try {
          const html = await fetchPage(url);
          const listings = parseListings(html, beds, zip);
          for (const l of listings) {
            zipListings.push({
              addressStreet: l.addressStreet,
              zip,
              beds: l.beds,
              baths: l.baths,
              sqft: l.sqft,
              listPriceCents: l.priceDollars * 100,
              sourceUrl: l.sourceUrl,
            });
          }
        } catch (e) {
          process.stdout.write(`[${beds}br:err] `);
        }
        await politeDelay();
      }

      if (!DRY_RUN && zipListings.length > 0) {
        const n = batchInsert(zipListings);
        totalInserted += n;
        console.log(`${zipListings.length} parsed, ${n} new saved`);
      } else {
        console.log(`${zipListings.length} parsed${DRY_RUN ? " (dry run)" : " (all dupes)"}`);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n── Results ─────────────────────────────────────────");
  console.log(`  Listings fetched : ${totalFetched.toLocaleString()}`);
  if (!DRY_RUN) {
    console.log(`  New properties   : ${totalInserted.toLocaleString()}`);
    const breakdown = db
      .prepare(
        `SELECT beds, COUNT(*) as n, AVG(list_price_cents)/100 as avg_price
         FROM properties WHERE source = 'craigslist-fsbo'
         GROUP BY beds ORDER BY beds`,
      )
      .all();
    if (breakdown.length > 0) {
      console.log("\n  All FSBO listings by bed count:");
      for (const row of breakdown) {
        console.log(`    ${row.beds ?? "?"}-bed: ${row.n} listings, avg $${Math.round(row.avg_price).toLocaleString()}`);
      }
    }
    if (totalInserted > 0) {
      console.log("\n  Next step: node scripts/score-properties.mjs");
    }
  }

  db.close();
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
