import Link from "next/link";
import { db } from "@/db";
import { properties, dealScores, rentEstimates } from "@/db/schema";
import { eq, desc, isNull, isNotNull } from "drizzle-orm";
import { fmtMoney, fmtPctFromBps } from "@/lib/scoring";

export const dynamic = "force-dynamic";

type Row = {
  property: typeof properties.$inferSelect;
  score: typeof dealScores.$inferSelect | null;
  rent: typeof rentEstimates.$inferSelect | null;
};

async function loadScored(): Promise<Row[]> {
  return db
    .select({ property: properties, score: dealScores, rent: rentEstimates })
    .from(properties)
    .innerJoin(dealScores, eq(dealScores.propertyId, properties.id))
    .leftJoin(rentEstimates, eq(rentEstimates.propertyId, properties.id))
    .where(eq(properties.status, "active"))
    .orderBy(desc(dealScores.compositeScore))
    .all();
}

async function loadUnscored(): Promise<Row[]> {
  // Properties that exist in DB but have no deal score yet (HCAD imports without rent comps)
  return db
    .select({ property: properties, score: dealScores, rent: rentEstimates })
    .from(properties)
    .leftJoin(dealScores, eq(dealScores.propertyId, properties.id))
    .leftJoin(rentEstimates, eq(rentEstimates.propertyId, properties.id))
    .where(eq(properties.status, "active"))
    .all()
    .filter((r) => r.score === null)
    .sort((a, b) =>
      (b.property.absenteeOwner ? 1 : 0) - (a.property.absenteeOwner ? 1 : 0),
    );
}

export default async function Home() {
  const [scored, unscored] = await Promise.all([loadScored(), loadUnscored()]);
  const total = scored.length + unscored.length;
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Houston Deal Finder</h1>
            <p className="text-sm text-zinc-500">
              {total === 0
                ? "No properties yet"
                : `${total.toLocaleString()} properties · ${scored.length} scored`}
            </p>
          </div>
          <Link
            href="/add"
            className="rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300"
          >
            Add property
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {total === 0 ? (
          <EmptyState />
        ) : (
          <>
            {scored.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 mb-3">
                  Scored leads ({scored.length})
                </h2>
                <LeadsTable rows={scored} />
              </section>
            )}

            {unscored.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 mb-1">
                  Needs rent estimate ({unscored.length.toLocaleString()})
                </h2>
                <p className="text-xs text-zinc-400 mb-3">
                  HCAD imports. Add a rent estimate on the property page to score.
                  Absentee-owner properties sorted first.
                </p>
                <UnscoredTable rows={unscored} />
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-12 text-center">
      <h2 className="text-lg font-medium">No properties yet</h2>
      <p className="mt-2 text-sm text-zinc-500">
        Run the HCAD importer to load the full Harris County dataset, or add a property manually.
      </p>
      <div className="mt-6 flex flex-col items-center gap-3">
        <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 text-xs">
          node scripts/hcad-import.mjs --limit 500
        </code>
        <Link
          href="/add"
          className="text-sm font-medium text-zinc-600 hover:underline"
        >
          or add one manually
        </Link>
      </div>
    </div>
  );
}

function LeadsTable({ rows }: { rows: Row[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-4 py-3 font-medium">Score</th>
            <th className="px-4 py-3 font-medium">Address</th>
            <th className="px-4 py-3 font-medium text-right">Price</th>
            <th className="px-4 py-3 font-medium text-right">Rent / mo</th>
            <th className="px-4 py-3 font-medium text-right">Cash flow / mo</th>
            <th className="px-4 py-3 font-medium text-right">Cap rate</th>
            <th className="px-4 py-3 font-medium text-right">CoC</th>
            <th className="px-4 py-3 font-medium">Flags</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {rows.map(({ property, score, rent }) => {
            const cashFlow = score!.monthlyCashFlowCents;
            const cashFlowColor =
              cashFlow > 0 ? "text-emerald-600" : cashFlow < 0 ? "text-rose-600" : "";
            return (
              <tr key={property.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                <td className="px-4 py-3">
                  <ScoreBadge score={score!.compositeScore} />
                </td>
                <td className="px-4 py-3">
                  <Link href={`/property/${property.id}`} className="font-medium hover:underline">
                    {property.addressStreet}
                  </Link>
                  <div className="text-xs text-zinc-500">
                    {property.addressCity} {property.addressZip}
                    {property.beds != null && ` · ${property.beds}bd`}
                    {property.baths != null && `/${property.baths}ba`}
                    {property.sqft != null && ` · ${property.sqft.toLocaleString()} sqft`}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {fmtMoney(property.listPriceCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {rent ? fmtMoney(rent.estimatedRentCents) : "—"}
                </td>
                <td className={`px-4 py-3 text-right tabular-nums ${cashFlowColor}`}>
                  {fmtMoney(cashFlow)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {fmtPctFromBps(score!.capRateBps)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {fmtPctFromBps(score!.cashOnCashBps)}
                </td>
                <td className="px-4 py-3">
                  <Flags property={property} score={score} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UnscoredTable({ rows }: { rows: Row[] }) {
  // Show at most 200 rows — full dataset can be very large after HCAD import
  const shown = rows.slice(0, 200);
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3 font-medium">Address</th>
              <th className="px-4 py-3 font-medium text-right">Appraised</th>
              <th className="px-4 py-3 font-medium text-right">Sqft</th>
              <th className="px-4 py-3 font-medium text-right">Built</th>
              <th className="px-4 py-3 font-medium">Flags</th>
              <th className="px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {shown.map(({ property }) => (
              <tr key={property.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                <td className="px-4 py-3">
                  <Link href={`/property/${property.id}`} className="font-medium hover:underline">
                    {property.addressStreet}
                  </Link>
                  <div className="text-xs text-zinc-500">
                    {property.addressCity} {property.addressZip}
                    {property.beds != null && ` · ${property.beds}bd`}
                    {property.baths != null && `/${property.baths}ba`}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-zinc-500 text-xs">
                  {fmtMoney(property.listPriceCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-xs">
                  {property.sqft ? property.sqft.toLocaleString() : "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-xs">
                  {property.yearBuilt ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <Flags property={property} score={null} />
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/property/${property.id}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    Add rent →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && (
        <p className="mt-2 text-xs text-zinc-400 text-right">
          Showing 200 of {rows.length.toLocaleString()} unscored. Add rent comps to score all automatically.
        </p>
      )}
    </>
  );
}

function Flags({
  property,
  score,
}: {
  property: typeof properties.$inferSelect;
  score: typeof dealScores.$inferSelect | null;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {score?.passesOnePct && <Pill tone="green">1% rule</Pill>}
      {property.absenteeOwner && <Pill tone="amber">absentee</Pill>}
      {property.floodZone && property.floodZone !== "X" && (
        <Pill tone="red">flood {property.floodZone}</Pill>
      )}
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 70
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
      : score >= 40
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      : "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md px-2 py-1 text-xs font-semibold tabular-nums ${tone}`}
    >
      {Math.round(score)}
    </span>
  );
}

function Pill({
  tone,
  children,
}: {
  tone: "green" | "amber" | "red";
  children: React.ReactNode;
}) {
  const styles = {
    green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    red: "bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  };
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${styles[tone]}`}
    >
      {children}
    </span>
  );
}
