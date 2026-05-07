# Houston Deal Finder

A Next.js web app that surfaces buy-and-hold rental investment leads in the Houston / Harris County market, scored by cash-on-cash return. Single-user, free-data-only side project.

## Setup

```bash
npm install
npm run db:push   # create ./data.db with schema
npm run dev       # http://localhost:3000
```

## What it does today

- Manually add a property (address, beds/baths/sqft, list price, est rent, optional tax record)
- Scores it under Houston-tuned defaults (2.3% effective tax, $2.8k/yr insurance, 7% mortgage, 25% down)
- Ranks all leads by composite score (cash-on-cash + cap rate + cash-flow penalty + 1%-rule bonus)
- Drill into any property to see the full monthly cash-flow breakdown

## What's planned

See [CLAUDE.md](./CLAUDE.md) for the architecture and roadmap. Next phases:

1. HCAD bulk ingestion → auto-populate properties, tax records, and flag absentee owners
2. Craigslist scraping for rent comps and FSBO listings
3. FEMA flood zone + tax-delinquency enrichment
4. Tunable assumptions in the UI

## Stack

Next.js (App Router) · TypeScript · Tailwind · Drizzle ORM · better-sqlite3
