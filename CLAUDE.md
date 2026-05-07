@AGENTS.md

# Houston Deal Finder

Buy-and-hold rental investment lead generator scoped to a single metro (Houston / Harris County) using only free data sources. Next.js App Router + TypeScript + Drizzle/SQLite. Single-user side project; no auth, no multi-tenancy.

## Commands

```
npm run dev          # dev server on :3000 (Turbopack)
npm run build        # production build
npm run lint         # ESLint
npm run db:push      # apply schema.ts to SQLite (dev iteration — no migration files)
npm run db:studio    # Drizzle Studio
```

The SQLite file lives at `./data.db` (gitignored). Override with `DB_PATH=...`.

## Architecture

The app is a thin pipeline: **listings → enrichment → scoring → ranked UI**. Today only the manual-entry endpoint feeds it; ingestion sources come in later phases.

### Data flow

1. A property arrives (manual form, later: HCAD bulk import, Craigslist FSBO scraper, paste-MLS-link).
2. `src/lib/scoring.ts` is invoked with `{listPriceCents, monthlyRentCents, annualTaxCentsOverride?, assumptions?}`.
3. The result is persisted in `deal_scores` (one row per property; unique index on `property_id`).
4. The leads page (`/`) joins `properties` ↔ `deal_scores` ↔ `rent_estimates` and orders by `composite_score DESC`.

### Money is integer cents

All currency is stored and computed as integer cents to avoid float drift. Convert at the boundary: `dollarsToCents` in `add/actions.ts` for input, `fmtMoney`/`fmtMoneyDetailed` in `lib/scoring.ts` for output. Never use float dollars in the DB.

### Percentages are basis points (where stored)

`cap_rate_bps`, `cash_on_cash_bps`, `gross_yield_bps` are basis points (8.50% = 850). User-facing assumptions (`downPaymentPct`, `mortgageRatePct`, etc.) are stored as percent floats because the UI surfaces them directly. Use `fmtPctFromBps` to render bps fields.

### Houston-specific defaults baked into scoring

`HOUSTON_DEFAULTS` in `src/lib/scoring.ts` reflects local realities, not national averages:

- **Effective property tax rate 2.3%** — TX has no state income tax, so property taxes do the work. MUDs and ISDs vary widely (1.8–3.5%); 2.3% is a blended baseline. *Always prefer the actual `annualTaxCentsOverride` from HCAD when present.*
- **Annual insurance $2,800** — wind + hail + flood + standard. Higher than national norms.
- **Mortgage rate 7%, 25% down, 30yr term** — current investor-loan defaults; surface these in the UI when adding configurability.

### Scoring math (`src/lib/scoring.ts`)

- **NOI** = annual (rent − operating expenses), excluding mortgage. Used for cap rate.
- **Cap rate** = NOI / list price.
- **Cash flow** = monthly rent − mortgage P&I − tax/12 − insurance/12 − vacancy − maintenance − mgmt. Can go negative.
- **Cash-on-cash** = annual cash flow / cash required (down + closing). The headline metric — most weighted in the composite.
- **1% rule** = monthly rent ≥ 1% of price. Coarse pass/fail screen.
- **Composite score 0–100** is a clamped weighted blend favoring cash-on-cash (40), cap rate (30), positive cash flow (±20), 1%-rule bonus (10). It is intentionally penalty-heavy on negative cash flow so a high cap rate alone can't mask a bleeder.

### Database (`src/db/schema.ts`)

| Table | Purpose |
|-------|---------|
| `properties` | Core record. `source` is the ingestion provenance (`manual`, later `hcad-import`, `craigslist`, `har`). `absentee_owner` is derived from owner-mailing-address ≠ property-address — a motivated-seller signal. `flood_zone` comes from FEMA NFHL (not yet wired). |
| `tax_records` | HCAD assessment + annual tax + owner. One per property; the scoring engine prefers `annualTaxCents` here over the 2.3% default. |
| `rent_estimates` | The rent number the score uses. `method` records provenance (`manual`, later `comps`, `fmr`). |
| `rent_comps` | Raw comp inventory keyed by `(zip, beds)`. Future rent-estimation queries match on this. |
| `deal_scores` | Computed metrics + `assumptions_json` snapshot so the breakdown page shows the math under the assumptions actually used at scoring time. |

`assumptions_json` snapshots are intentional: when defaults change, old scores still display the math that produced them.

## Conventions

- **Server components by default.** All page rendering reads via `db` directly. Client components are only for interactivity that can't be done with form actions.
- **Form mutations are server actions** (`src/app/add/actions.ts` pattern), not API routes. They handle input parsing, DB writes, scoring, and `revalidatePath` + `redirect`.
- **No client-side data fetching.** Pages are `dynamic = "force-dynamic"` so SQLite reads run per request.
- **`better-sqlite3` is synchronous.** Use `.get()` / `.all()` / `.run()`, not awaited promises.

## Free-data sources (planned, not yet implemented)

| Layer | Source | Status |
|-------|--------|--------|
| Property + tax + owner | HCAD public bulk download (tab-delimited, `Real_acct_owner.zip` + `Real_building_land.zip`) | ✅ done |
| Sale comps | Harris County Clerk recorder | not yet |
| Rent comps | Craigslist Houston + Facebook Marketplace; HUD FMR fallback | not yet |
| For-sale listings | Craigslist FSBO + paste-MLS-link form (HAR.com URLs) | not yet |
| Flood zone | FEMA NFHL (free GIS query by lat/lng) | not yet |
| Tax delinquency | Harris County Tax Assessor-Collector | not yet |

**Do not scrape Zillow, Redfin, or Trulia.** Their ToS forbids it, they actively block, and they send C&Ds. HAR.com is in a similar gray area for bulk scraping — prefer a paste-a-URL UX over crawling.

## HCAD import script (`scripts/hcad-import.mjs`)

Downloads and ingests the full Harris County property database.

```
# First run — downloads ~400MB, imports all SFR ($50k–$600k):
node scripts/hcad-import.mjs

# Subsequent runs — reuse already-extracted files:
node scripts/hcad-import.mjs --skip-download

# Test run (dev server can stay up):
node scripts/hcad-import.mjs --skip-download --limit 500

# Inspect raw file format:
node scripts/hcad-import.mjs --skip-download --discover
```

**Stop `npm run dev` before a full (no `--limit`) import.** The dev server holds a SQLite write lock that blocks batch inserts. A `--limit 500` test run works with the server up.

Files in `./hcad-data/` (gitignored). Downloads from `https://download.hcad.org/data/CAMA/YEAR/`.

Key decisions: filters state_class A1+A2; uses `tot_appr_val` as price proxy; estimates tax at `assessed_val × 2.3%`; absentee flag when `mail_state ≠ TX` OR `mail_zip ≠ site_zip`; beds/baths from EAV `fixtures.txt` matching "bed"/"full bath"/"half" in type_dscr. Properties import without `deal_scores` — scoring fires once a rent estimate is added.

## Roadmap

1. ✅ Scaffold + scoring + manual entry + leads UI
2. ✅ HCAD bulk ingestion (126K properties, 28K absentee-flagged, in DB as of 2026-05-06)
3. Rent comp scraping (Craigslist) + rent estimation by zip+beds median → triggers deal scoring
4. Listing ingestion (Craigslist FSBO + HAR.com paste form) → real ask price replaces appraisal proxy
5. FEMA flood zone enrichment + tax-delinquency flag
6. User-tunable assumptions UI (override defaults per session/property)
