#!/usr/bin/env node
/**
 * Craigslist Houston Rent Comps Scraper
 *
 * Scrapes asking rents from houston.craigslist.org apartment listings and
 * populates the rent_comps table. Two-pass approach:
 *
 *   Pass 1 — General Houston search (no zip filter)
 *     One request per bedroom count → ~200 comps each, stored with zip when
 *     extractable from the listing text.
 *
 *   Pass 2 — Per-zip search
 *     For the top N zips from the DB, search with postal= filter so comps
 *     are tied to a specific zip code. Skipped with --general-only.
 *
 * Usage:
 *   node scripts/craigslist-comps.mjs
 *   node scripts/craigslist-comps.mjs --general-only          # Pass 1 only (fast)
 *   node scripts/craigslist-comps.mjs --top-zips 30           # top 30 zips (default 50)
 *   node scripts/craigslist-comps.mjs --beds 3                # only 3-bed comps
 *   node scripts/craigslist-comps.mjs --dry-run               # parse but don't write
 *
 * After running, execute:
 *   node scripts/score-properties.mjs
 */

import { createInterface } from "node:readline";
import Database from "better-sqlite3";

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const GENERAL_ONLY = hasFlag("--general-only");
const DRY_RUN = hasFlag("--dry-run");
const TOP_ZIPS = parseInt(getArg("--top-zips", "50"), 10);
const BEDS_FILTER = getArg("--beds", null); // null = all bed counts
const BED_COUNTS = BEDS_FILTER
  ? [parseInt(BEDS_FILTER, 10)]
  : [1, 2, 3, 4];

// Polite scraping: random delay between requests (2-4 seconds)
const DELAY_MIN = 2000;
const DELAY_MAX = 4000;
const BASE_URL = "https://houston.craigslist.org";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── COOKIE JAR ───────────────────────────────────────────────────────────────
// Craigslist sets a cl_b tracking cookie on first visit that must be carried
// through subsequent requests to avoid 301 redirect loops.

let cookieJar = "";

function updateCookies(res) {
  // Node 24 fetch: res.headers.getSetCookie() is an array
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

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function politeDelay() {
  const ms = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
  await sleep(ms);
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
 * Parse Craigslist no-JS static search result HTML.
 * Returns an array of {price, zip, url} objects.
 *
 * Listing HTML structure:
 *   <li class="cl-static-search-result" title="TITLE">
 *     <a href="URL">
 *       <div class="title">TITLE</div>
 *       <div class="details">
 *         <div class="price">$1,500</div>
 *         <div class="location">Heights Area</div>
 *       </div>
 *     </a>
 *   </li>
 */
function parseListings(html, knownBeds) {
  const results = [];
  // Match each listing block
  const blockRe = /class="cl-static-search-result"[^>]*title="([^"]*)"[\s\S]*?<div class="price">\s*(\$[\d,]+)\s*<\/div>[\s\S]*?<div class="location">\s*([^<]*?)\s*<\/div>[\s\S]*?<\/li>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const title = htmlDecode(m[1]);
    const priceStr = m[2].replace(/[$,]/g, "");
    const location = htmlDecode(m[3].trim());

    const priceDollars = parseInt(priceStr, 10);
    if (!priceDollars || priceDollars < 200 || priceDollars > 20000) continue;

    // Try to extract a Houston-area zip (77xxx) from title or location
    const zipMatch = (title + " " + location).match(/\b(77\d{3})\b/);
    const zip = zipMatch ? zipMatch[1] : null;

    // Try to extract bedroom count from title when not provided by caller
    let beds = knownBeds;
    if (!beds) {
      const bedsMatch = title.match(/(\d+)\s*(?:bed|br|bdrm|bedroom)/i);
      beds = bedsMatch ? parseInt(bedsMatch[1], 10) : null;
    }

    // Basic sanity: beds 1-6, price sensible for Houston rentals
    if (beds && (beds < 1 || beds > 6)) continue;
    // Filter to plausible Houston properties (skip Baytown/Conroe outliers where price is extreme)
    const houstonLike = !/\b(beaumont|conroe|galveston|angleton|bay city)\b/i.test(location);

    results.push({ priceDollars, zip, beds, location, houstonLike });
  }
  return results;
}

// ── DB ────────────────────────────────────────────────────────────────────────

function openDb() {
  const db = new Database(process.env.DB_PATH ?? "./data.db", { timeout: 30000 });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Craigslist Houston Rent Comps Scraper");
  if (DRY_RUN) console.log("  (dry run — no DB writes)");
  console.log(`  Bed counts: ${BED_COUNTS.join(", ")}`);

  const db = openDb();

  const insertComp = db.prepare(`
    INSERT INTO rent_comps (zip, beds, asking_rent_cents, source, source_url)
    VALUES (@zip, @beds, @askingRentCents, 'craigslist', NULL)
  `);

  // Clear old comps before re-scraping (keep the data fresh)
  if (!DRY_RUN) {
    const deleted = db.prepare("DELETE FROM rent_comps WHERE source = 'craigslist'").run();
    console.log(`\n  Cleared ${deleted.changes} old Craigslist comps`);
  }

  let totalInserted = 0;
  let totalFetched = 0;

  // ── Seed cookie jar ───────────────────────────────────────────────────────

  console.log("\nStep 1: Getting session cookie...");
  try {
    await fetchPage(`${BASE_URL}/`);
    console.log(`  ✓ Cookie: ${cookieJar.slice(0, 60)}...`);
  } catch (e) {
    console.warn("  ⚠ Could not seed cookie:", e.message);
  }
  await politeDelay();

  // ── Pass 1: General Houston search ────────────────────────────────────────

  console.log("\nStep 2: General Houston search (no zip filter)");

  const batchInsert = db.transaction((rows) => {
    let n = 0;
    for (const row of rows) {
      insertComp.run(row);
      n++;
    }
    return n;
  });

  for (const beds of BED_COUNTS) {
    const url = `${BASE_URL}/search/apa?min_bedrooms=${beds}&max_bedrooms=${beds}`;
    process.stdout.write(`  ${beds}-bed... `);
    try {
      const html = await fetchPage(url);
      const listings = parseListings(html, beds);
      totalFetched += listings.length;

      const toInsert = listings.map((l) => ({
        zip: l.zip,
        beds: l.beds,
        askingRentCents: l.priceDollars * 100,
      }));

      if (!DRY_RUN) {
        const n = batchInsert(toInsert);
        totalInserted += n;
        console.log(`${listings.length} parsed, ${n} saved (${toInsert.filter((r) => r.zip).length} with zip)`);
      } else {
        console.log(`${listings.length} parsed (dry run)`);
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
    await politeDelay();
  }

  // ── Pass 2: Per-zip searches ───────────────────────────────────────────────

  if (!GENERAL_ONLY) {
    console.log(`\nStep 3: Per-zip search (top ${TOP_ZIPS} zips by property count)`);

    // Get the most populated zip codes from the DB to target our searches
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

      const zipComps = [];
      for (const beds of BED_COUNTS) {
        const url = `${BASE_URL}/search/apa?min_bedrooms=${beds}&max_bedrooms=${beds}&postal=${zip}&search_distance=2`;
        try {
          const html = await fetchPage(url);
          const listings = parseListings(html, beds);
          // All results from a postal search are tagged with the searched zip
          for (const l of listings) {
            zipComps.push({
              zip,
              beds,
              askingRentCents: l.priceDollars * 100,
            });
          }
        } catch (e) {
          process.stdout.write(`[${beds}br:err] `);
        }
        await politeDelay();
      }

      if (!DRY_RUN && zipComps.length > 0) {
        const n = batchInsert(zipComps);
        totalInserted += n;
        console.log(`${zipComps.length} comps saved`);
      } else {
        console.log(`${zipComps.length} comps (dry run)`);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n── Results ─────────────────────────────────────────");
  console.log(`  Listings fetched : ${totalFetched.toLocaleString()}`);
  if (!DRY_RUN) {
    console.log(`  Comps saved      : ${totalInserted.toLocaleString()}`);
    const breakdown = db
      .prepare("SELECT beds, COUNT(*) as n, AVG(asking_rent_cents)/100 as avg_rent FROM rent_comps WHERE source='craigslist' GROUP BY beds ORDER BY beds")
      .all();
    console.log("\n  Avg rent by bed count (Houston-wide):");
    for (const row of breakdown) {
      console.log(`    ${row.beds}-bed: $${Math.round(row.avg_rent).toLocaleString()}/mo  (${row.n} comps)`);
    }
    const withZip = db
      .prepare("SELECT COUNT(*) as n FROM rent_comps WHERE source='craigslist' AND zip IS NOT NULL")
      .get().n;
    const total = db
      .prepare("SELECT COUNT(*) as n FROM rent_comps WHERE source='craigslist'")
      .get().n;
    console.log(`\n  Comps with zip: ${withZip} / ${total}`);
    console.log("\n  Next step: node scripts/score-properties.mjs");
  }

  db.close();
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
