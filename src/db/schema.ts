import { sqliteTable, integer, text, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const properties = sqliteTable(
  "properties",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hcadAccount: text("hcad_account"),
    addressStreet: text("address_street").notNull(),
    addressCity: text("address_city").notNull().default("Houston"),
    addressZip: text("address_zip").notNull(),
    latitude: real("latitude"),
    longitude: real("longitude"),
    beds: integer("beds"),
    baths: real("baths"),
    sqft: integer("sqft"),
    yearBuilt: integer("year_built"),
    listPriceCents: integer("list_price_cents").notNull(),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    absenteeOwner: integer("absentee_owner", { mode: "boolean" }).default(false),
    floodZone: text("flood_zone"),
    notes: text("notes"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("properties_hcad_account_idx").on(t.hcadAccount),
    index("properties_zip_idx").on(t.addressZip),
  ],
);

export const taxRecords = sqliteTable("tax_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  propertyId: integer("property_id")
    .notNull()
    .references(() => properties.id, { onDelete: "cascade" }),
  assessedValueCents: integer("assessed_value_cents").notNull(),
  annualTaxCents: integer("annual_tax_cents").notNull(),
  ownerName: text("owner_name"),
  ownerMailingAddress: text("owner_mailing_address"),
  taxYear: integer("tax_year"),
  delinquent: integer("delinquent", { mode: "boolean" }).default(false),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const rentEstimates = sqliteTable("rent_estimates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  propertyId: integer("property_id")
    .notNull()
    .references(() => properties.id, { onDelete: "cascade" }),
  estimatedRentCents: integer("estimated_rent_cents").notNull(),
  lowCents: integer("low_cents"),
  highCents: integer("high_cents"),
  method: text("method").notNull(),
  sampleSize: integer("sample_size"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const rentComps = sqliteTable(
  "rent_comps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    zip: text("zip"),
    beds: integer("beds").notNull(),
    baths: real("baths"),
    sqft: integer("sqft"),
    askingRentCents: integer("asking_rent_cents").notNull(),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    scrapedAt: integer("scraped_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("rent_comps_zip_beds_idx").on(t.zip, t.beds)],
);

export const dealScores = sqliteTable(
  "deal_scores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    monthlyCashFlowCents: integer("monthly_cash_flow_cents").notNull(),
    capRateBps: integer("cap_rate_bps").notNull(),
    cashOnCashBps: integer("cash_on_cash_bps").notNull(),
    grossYieldBps: integer("gross_yield_bps").notNull(),
    passesOnePct: integer("passes_one_pct", { mode: "boolean" }).notNull(),
    compositeScore: real("composite_score").notNull(),
    assumptionsJson: text("assumptions_json").notNull(),
    computedAt: integer("computed_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("deal_scores_property_idx").on(t.propertyId)],
);

export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;
export type DealScore = typeof dealScores.$inferSelect;
export type NewDealScore = typeof dealScores.$inferInsert;
export type TaxRecord = typeof taxRecords.$inferSelect;
export type RentEstimate = typeof rentEstimates.$inferSelect;
