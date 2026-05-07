#!/usr/bin/env node
/**
 * HCAD Bulk Importer
 *
 * Downloads Harris County Appraisal District public data and ingests
 * residential properties into the deal-finder database.
 *
 * Sources (all free, public):
 *   https://download.hcad.org/data/CAMA/YEAR/Real_acct_owner.zip
 *   https://download.hcad.org/data/CAMA/YEAR/Real_building_land.zip
 *
 * Usage:
 *   node scripts/hcad-import.mjs
 *   node scripts/hcad-import.mjs --year 2025 --min-price 60000 --max-price 450000
 *   node scripts/hcad-import.mjs --limit 2000            # test run
 *   node scripts/hcad-import.mjs --skip-download         # files already in ./hcad-data/
 *   node scripts/hcad-import.mjs --discover              # print sample rows and column counts
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const YEAR = getArg("--year", "2025");
const DATA_DIR = resolve(getArg("--data-dir", "./hcad-data"));
const MIN_PRICE = parseInt(getArg("--min-price", "50000"), 10);
const MAX_PRICE = parseInt(getArg("--max-price", "600000"), 10);
const LIMIT = parseInt(getArg("--limit", "0"), 10); // 0 = unlimited
const SKIP_DOWNLOAD = hasFlag("--skip-download");
const DISCOVER = hasFlag("--discover");
// State classes to include. A1=SFR, A2=SFR w/accessory, A4=residential condo (useful too).
const STATE_CLASSES = new Set(
  getArg("--state-classes", "A1,A2")
    .split(",")
    .map((s) => s.trim()),
);
const BATCH_SIZE = 500;
const BASE_URL = `https://download.hcad.org/data/CAMA/${YEAR}`;

// ── COLUMN MAPS ─────────────────────────────────────────────────────────────
// All files are tab-delimited with no header row.
// Indices confirmed against HCAD codebook (sql_workshop_2022 CREATE TABLE statements).

const RA = {
  acct: 0,
  mailto: 2, // owner name on file
  mail_addr_1: 3,
  mail_city: 5,
  mail_state: 6,
  mail_zip: 7,
  site_addr_1: 17, // formatted street: "1234 MAIN ST"
  site_addr_3: 19, // property zip
  state_class: 20,
  assessed_val: 47, // capped assessed value (used for tax calc)
  tot_appr_val: 48, // HCAD appraised value (price proxy)
};

const BR = {
  acct: 0,
  property_use_cd: 1,
  bld_num: 2,
  date_erected: 12, // year built
  heat_ar: 21, // heated/living area sqft (primary)
  base_ar: 24, // fallback sqft
};

// fixtures.txt is EAV: one row per fixture per building.
// Expected columns: acct, bld_num, fixture_type (code), type_dscr (label), units (count).
// We match type_dscr case-insensitively: "bed"→beds, "full"+"bath"→baths, "half"→halfBaths.
const FX = { acct: 0, bld_num: 1, type_dscr: 3, units: 4 };

// ── HELPERS ─────────────────────────────────────────────────────────────────

function num(s) {
  const n = parseFloat(String(s ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function int(s) {
  const n = parseInt(String(s ?? "").trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function str(s) {
  return String(s ?? "").trim();
}

async function streamLines(filePath, onLine) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "latin1" }),
    crlfDelay: Infinity,
  });
  let count = 0;
  let isFirstRow = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    // Skip header rows — HCAD files inconsistently include them.
    // A header row has "acct" (the column name) in the first field.
    if (isFirstRow) {
      isFirstRow = false;
      if (cols[0].trim().toLowerCase() === "acct") continue;
    }
    await onLine(cols, count);
    count++;
  }
  return count;
}

async function discoverFile(filePath, label, n = 5) {
  console.log(`\n=== ${label} (${filePath}) — first ${n} rows ===`);
  let i = 0;
  await streamLines(filePath, async (cols) => {
    if (i++ >= n) return;
    console.log(`row ${i - 1} [${cols.length} cols]:`, cols.slice(0, 10).join(" | "), "...");
  });
}

// ── DOWNLOAD & EXTRACT ───────────────────────────────────────────────────────

async function downloadFile(url, dest) {
  console.log(`  ↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = parseInt(res.headers.get("content-length") ?? "0", 10);
  let received = 0;
  const out = createWriteStream(dest);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(value);
      received += value.length;
      if (total) {
        const pct = ((received / total) * 100).toFixed(1);
        process.stdout.write(`\r    ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB  (${pct}%)   `);
      }
    }
  } finally {
    reader.releaseLock();
  }
  await new Promise((res, rej) => out.close((e) => (e ? rej(e) : res())));
  console.log(`\r    ${(received / 1e6).toFixed(1)} MB — done.                    `);
}

async function ensureExtracted(zipName, wantFiles) {
  const missing = wantFiles.filter((f) => !existsSync(join(DATA_DIR, f)));
  if (missing.length === 0) {
    console.log(`  ✓ ${wantFiles.join(", ")} already present`);
    return;
  }
  const zipPath = join(DATA_DIR, zipName);
  if (!existsSync(zipPath)) {
    await downloadFile(`${BASE_URL}/${zipName}`, zipPath);
  }
  console.log(`  ⊕ extracting ${zipName}...`);
  // -j = junk paths (flat extraction), -o = overwrite, -d = destination
  execFileSync("unzip", ["-j", "-o", zipPath, "-d", DATA_DIR], { stdio: "inherit" });
  console.log(`  ✓ extracted`);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`HCAD Import — year ${YEAR}, price $${MIN_PRICE.toLocaleString()}–$${MAX_PRICE.toLocaleString()}`);
  console.log(`State classes: ${[...STATE_CLASSES].join(", ")}`);
  if (LIMIT) console.log(`Limit: ${LIMIT} properties`);

  mkdirSync(DATA_DIR, { recursive: true });

  // Warn if the dev server is likely running — it holds the SQLite write lock.
  // Stop it before running a full import (Ctrl-C in the terminal where `npm run dev` is running).
  // A 500-property test run with --limit is fine either way.

  // ── Step 1: Download + extract ──────────────────────────────────────────

  if (!SKIP_DOWNLOAD) {
    console.log("\nStep 1: Ensure data files present");
    await ensureExtracted("Real_acct_owner.zip", ["real_acct.txt"]);
    await ensureExtracted("Real_building_land.zip", ["building_res.txt", "fixtures.txt"]);
  } else {
    console.log("\nStep 1: Skipping download (--skip-download)");
  }

  const acctFile = join(DATA_DIR, "real_acct.txt");
  const bldFile = join(DATA_DIR, "building_res.txt");
  const fixFile = join(DATA_DIR, "fixtures.txt");

  for (const [label, path] of [
    ["real_acct.txt", acctFile],
    ["building_res.txt", bldFile],
    ["fixtures.txt", fixFile],
  ]) {
    if (!existsSync(path)) {
      console.error(`\n✗ Missing: ${path}\n  Run without --skip-download, or place files in ${DATA_DIR}`);
      process.exit(1);
    }
  }

  // ── Discover mode ────────────────────────────────────────────────────────

  if (DISCOVER) {
    await discoverFile(acctFile, "real_acct.txt");
    await discoverFile(bldFile, "building_res.txt");
    await discoverFile(fixFile, "fixtures.txt");
    console.log("\n-- discover done. Run without --discover to import.");
    process.exit(0);
  }

  // ── Step 2: Load building_res → memory map ───────────────────────────────

  console.log("\nStep 2: Loading building_res.txt...");
  // Map<acct, {useCode, yearBuilt, sqft}>
  const bldMap = new Map();
  let bldRows = 0;
  await streamLines(bldFile, async (cols) => {
    const acct = str(cols[BR.acct]);
    if (!acct) return;
    const useCode = str(cols[BR.property_use_cd]);
    const yearBuilt = int(cols[BR.date_erected]);
    const sqft = num(cols[BR.heat_ar]) || num(cols[BR.base_ar]);
    // Keep first building record per account (bld_num "1" is the primary)
    if (!bldMap.has(acct)) {
      bldMap.set(acct, { useCode, yearBuilt, sqft });
    }
    bldRows++;
  });
  console.log(`  ✓ ${bldRows.toLocaleString()} rows → ${bldMap.size.toLocaleString()} accounts`);

  // ── Step 3: Load fixtures → memory map ──────────────────────────────────

  console.log("\nStep 3: Loading fixtures.txt (beds/baths)...");
  // Map<acct, {beds, baths, halfBaths}>
  const fxMap = new Map();
  let fxRows = 0;
  let fxSamplePrinted = false;
  await streamLines(fixFile, async (cols) => {
    const acct = str(cols[FX.acct]);
    if (!acct) return;
    fxRows++;

    if (!fxSamplePrinted && fxRows <= 3) {
      console.log(`  sample row ${fxRows} [${cols.length} cols]:`, cols.slice(0, 6).join(" | "));
      if (fxRows === 3) fxSamplePrinted = true;
    }

    const typeDscr = str(cols[FX.type_dscr]).toLowerCase();
    const units = int(cols[FX.units]);
    if (units <= 0) return;

    if (!fxMap.has(acct)) fxMap.set(acct, { beds: 0, baths: 0, halfBaths: 0 });
    const rec = fxMap.get(acct);

    if (typeDscr.includes("bed")) rec.beds += units;
    else if (typeDscr.includes("full") && typeDscr.includes("bath")) rec.baths += units;
    else if (typeDscr.includes("half") || typeDscr.includes("h bath")) rec.halfBaths += units;
    // Also handle codes that might appear without "full": "bath" alone means full bath
    else if (typeDscr === "bath" || typeDscr === "baths") rec.baths += units;
  });
  console.log(`  ✓ ${fxRows.toLocaleString()} fixture rows → ${fxMap.size.toLocaleString()} accounts with fixtures`);

  // ── Step 4: Open DB + prepare statements ────────────────────────────────

  const dbPath = process.env.DB_PATH ?? "./data.db";
  // timeout: ms to wait for write lock; dev server may hold an open WAL reader
  const db = new Database(dbPath, { timeout: 60000 });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const upsertProp = db.prepare(`
    INSERT INTO properties (
      hcad_account, address_street, address_city, address_zip,
      beds, baths, sqft, year_built,
      list_price_cents, source, absentee_owner, notes, status
    ) VALUES (
      @hcadAccount, @addressStreet, @addressCity, @addressZip,
      @beds, @baths, @sqft, @yearBuilt,
      @listPriceCents, 'hcad-import', @absenteeOwner,
      @notes, 'active'
    )
    ON CONFLICT(hcad_account) DO UPDATE SET
      address_street = excluded.address_street,
      address_zip    = excluded.address_zip,
      beds           = excluded.beds,
      baths          = excluded.baths,
      sqft           = excluded.sqft,
      year_built     = excluded.year_built,
      list_price_cents = excluded.list_price_cents,
      absentee_owner = excluded.absentee_owner,
      updated_at     = (unixepoch() * 1000)
    RETURNING id
  `);

  const upsertTax = db.prepare(`
    INSERT INTO tax_records (property_id, assessed_value_cents, annual_tax_cents, owner_name, owner_mailing_address, tax_year)
    VALUES (@propertyId, @assessedValueCents, @annualTaxCents, @ownerName, @ownerMailingAddress, @taxYear)
    ON CONFLICT DO NOTHING
  `);

  // Check if tax_records has a unique constraint we can use for upsert.
  // The schema only has PK, no unique on property_id for tax_records.
  // So we need to delete existing before insert to avoid duplicates on re-run.
  const deleteTax = db.prepare(`DELETE FROM tax_records WHERE property_id = ?`);

  const batchInsert = db.transaction((rows) => {
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const existing = db
        .prepare("SELECT id FROM properties WHERE hcad_account = ?")
        .get(row.hcadAccount);

      let propId;
      if (existing) {
        // Update existing
        db.prepare(`
          UPDATE properties SET
            address_street = @addressStreet,
            address_zip = @addressZip,
            beds = @beds,
            baths = @baths,
            sqft = @sqft,
            year_built = @yearBuilt,
            list_price_cents = @listPriceCents,
            absentee_owner = @absenteeOwner,
            notes = @notes,
            updated_at = (unixepoch() * 1000)
          WHERE hcad_account = @hcadAccount
        `).run(row);
        propId = existing.id;
        updated++;
      } else {
        const result = db.prepare(`
          INSERT INTO properties (
            hcad_account, address_street, address_city, address_zip,
            beds, baths, sqft, year_built,
            list_price_cents, source, absentee_owner, notes, status
          ) VALUES (
            @hcadAccount, @addressStreet, 'Houston', @addressZip,
            @beds, @baths, @sqft, @yearBuilt,
            @listPriceCents, 'hcad-import', @absenteeOwner,
            @notes, 'active'
          )
        `).run(row);
        propId = result.lastInsertRowid;
        inserted++;
      }

      deleteTax.run(propId);
      upsertTax.run({
        propertyId: propId,
        assessedValueCents: row.assessedValueCents,
        annualTaxCents: row.annualTaxCents,
        ownerName: row.ownerName,
        ownerMailingAddress: row.ownerMailingAddress,
        taxYear: parseInt(YEAR, 10),
      });
    }
    return { inserted, updated };
  });

  // ── Step 5: Stream real_acct.txt ─────────────────────────────────────────

  console.log("\nStep 4: Streaming real_acct.txt...");
  let lineCount = 0;
  let acceptCount = 0;
  let skippedClass = 0;
  let skippedPrice = 0;
  let skippedZip = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let done = false;
  let batch = [];

  const flush = () => {
    if (batch.length === 0) return;
    const { inserted, updated } = batchInsert(batch);
    totalInserted += inserted;
    totalUpdated += updated;
    batch = [];
  };

  await streamLines(acctFile, async (cols) => {
    if (done) return;
    lineCount++;

    if (lineCount % 50000 === 0) {
      process.stdout.write(
        `\r  ${lineCount.toLocaleString()} rows read, ${acceptCount.toLocaleString()} accepted, ${(totalInserted + totalUpdated).toLocaleString()} saved...   `,
      );
    }

    const acct = str(cols[RA.acct]);
    if (!acct) return;

    // Filter: state class must be in allowed set
    const stateClass = str(cols[RA.state_class]);
    if (!STATE_CLASSES.has(stateClass)) {
      skippedClass++;
      return;
    }

    // Filter: zip must look valid
    const zip = str(cols[RA.site_addr_3]);
    if (!zip || zip.length < 5 || !/^\d{5}/.test(zip)) {
      skippedZip++;
      return;
    }

    // Filter: price in range
    const appraisedVal = int(cols[RA.tot_appr_val]) || int(cols[RA.assessed_val]);
    if (appraisedVal < MIN_PRICE || appraisedVal > MAX_PRICE) {
      skippedPrice++;
      return;
    }

    // Absentee owner: owner state ≠ TX  OR  owner zip ≠ property zip
    const mailState = str(cols[RA.mail_state]);
    const mailZip = str(cols[RA.mail_zip]).slice(0, 5);
    const propZip = zip.slice(0, 5);
    const absenteeOwner = mailState !== "TX" || mailZip !== propZip;

    // Owner mailing address (for display)
    const ownerName = str(cols[RA.mailto]);
    const mailAddr1 = str(cols[RA.mail_addr_1]);
    const mailCity = str(cols[RA.mail_city]);
    const ownerMailingAddress = [mailAddr1, mailCity, mailState].filter(Boolean).join(", ");

    // Join building data
    const bld = bldMap.get(acct);
    const fx = fxMap.get(acct);

    const yearBuilt = bld?.yearBuilt ?? 0;
    const sqft = bld ? Math.round(bld.sqft) : 0;
    const beds = fx?.beds ?? null;
    const baths = fx ? (fx.baths + fx.halfBaths * 0.5) : null;

    // Tax estimate (assessed_val * 2.3% annual effective rate)
    const assessedVal = int(cols[RA.assessed_val]) || appraisedVal;
    const assessedValueCents = assessedVal * 100;
    const annualTaxCents = Math.round(assessedVal * 0.023 * 100);

    // Street address
    const streetAddr = str(cols[RA.site_addr_1]);
    if (!streetAddr) return;

    batch.push({
      hcadAccount: acct,
      addressStreet: streetAddr,
      addressZip: zip.slice(0, 5),
      beds: beds ?? null,
      baths: baths ?? null,
      sqft: sqft || null,
      yearBuilt: yearBuilt || null,
      listPriceCents: appraisedVal * 100,
      absenteeOwner: absenteeOwner ? 1 : 0,
      notes: `HCAD appraised value $${appraisedVal.toLocaleString()} — price is an estimate, not an active listing.`,
      assessedValueCents,
      annualTaxCents,
      ownerName: ownerName || null,
      ownerMailingAddress: ownerMailingAddress || null,
    });
    acceptCount++;

    if (batch.length >= BATCH_SIZE) flush();

    if (LIMIT > 0 && acceptCount >= LIMIT) {
      flush();
      done = true;
    }
  });

  flush();
  console.log(`\r  ${lineCount.toLocaleString()} rows read, ${acceptCount.toLocaleString()} accepted.                   `);

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log("\n── Results ─────────────────────────────────────────");
  console.log(`  Properties inserted : ${totalInserted.toLocaleString()}`);
  console.log(`  Properties updated  : ${totalUpdated.toLocaleString()}`);
  console.log(`  Skipped (class)     : ${skippedClass.toLocaleString()}`);
  console.log(`  Skipped (price)     : ${skippedPrice.toLocaleString()}`);
  console.log(`  Skipped (zip)       : ${skippedZip.toLocaleString()}`);

  const absenteeCount = db
    .prepare("SELECT COUNT(*) as n FROM properties WHERE source='hcad-import' AND absentee_owner=1")
    .get().n;
  const totalHcad = db
    .prepare("SELECT COUNT(*) as n FROM properties WHERE source='hcad-import'")
    .get().n;
  console.log(`\n  Total HCAD properties in DB : ${totalHcad.toLocaleString()}`);
  console.log(`  Absentee owner flagged      : ${absenteeCount.toLocaleString()}`);
  console.log("\n  Next step: run rent comps scraper (phase 3) to enable deal scoring.");
  console.log("  Or: open a property in the UI and add a rent estimate manually.");

  db.close();
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
