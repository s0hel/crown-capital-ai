import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { properties, dealScores, rentEstimates, taxRecords } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  fmtMoney,
  fmtMoneyDetailed,
  fmtPctFromBps,
  HOUSTON_DEFAULTS,
  type Assumptions,
} from "@/lib/scoring";
import { addRentEstimateAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function PropertyDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isFinite(id)) notFound();

  const property = db.select().from(properties).where(eq(properties.id, id)).get();
  if (!property) notFound();

  const score = db.select().from(dealScores).where(eq(dealScores.propertyId, id)).get();
  const rent = db.select().from(rentEstimates).where(eq(rentEstimates.propertyId, id)).get();
  const tax = db.select().from(taxRecords).where(eq(taxRecords.propertyId, id)).get();

  const assumptions: Assumptions | null = score
    ? (JSON.parse(score.assumptionsJson) as Assumptions)
    : null;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-5xl mx-auto px-6 py-5">
          <Link href="/" className="text-sm text-zinc-500 hover:underline">
            ← All leads
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {property.addressStreet}
          </h1>
          <p className="text-sm text-zinc-500">
            {property.addressCity} {property.addressZip}
            {property.beds != null && ` · ${property.beds} bed`}
            {property.baths != null && ` / ${property.baths} bath`}
            {property.sqft != null && ` · ${property.sqft.toLocaleString()} sqft`}
            {property.yearBuilt != null && ` · built ${property.yearBuilt}`}
          </p>
          {property.sourceUrl && (
            <a
              href={property.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-blue-600 hover:underline"
            >
              View original listing ({property.source}) ↗
            </a>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Stat label="List price" value={fmtMoney(property.listPriceCents)} />
          <Stat label="Estimated rent" value={rent ? fmtMoney(rent.estimatedRentCents) : "—"} />
          <Stat
            label="Composite score"
            value={score ? Math.round(score.compositeScore).toString() : "—"}
            tone={
              score == null
                ? "neutral"
                : score.compositeScore >= 70
                ? "good"
                : score.compositeScore >= 40
                ? "warn"
                : "bad"
            }
          />
        </div>

        {score && (
          <Section title="Returns">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Stat
                label="Monthly cash flow"
                value={fmtMoney(score.monthlyCashFlowCents)}
                tone={
                  score.monthlyCashFlowCents > 0
                    ? "good"
                    : score.monthlyCashFlowCents < 0
                    ? "bad"
                    : "neutral"
                }
              />
              <Stat label="Cap rate" value={fmtPctFromBps(score.capRateBps)} />
              <Stat label="Cash on cash" value={fmtPctFromBps(score.cashOnCashBps)} />
              <Stat label="Gross yield" value={fmtPctFromBps(score.grossYieldBps)} />
            </div>
            <div className="mt-3 text-sm text-zinc-500">
              {score.passesOnePct
                ? "✓ Passes the 1% rule (rent ≥ 1% of price)"
                : "✗ Does not pass the 1% rule"}
            </div>
          </Section>
        )}

        {!score && (
          <Section title="Add rent estimate to score">
            <form
              action={addRentEstimateAction.bind(null, property.id)}
              className="flex items-end gap-3"
            >
              <label className="flex-1 block">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Estimated monthly rent ($)
                </span>
                <input
                  name="rent"
                  type="number"
                  step="1"
                  required
                  placeholder="1800"
                  className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300"
              >
                Score
              </button>
            </form>
            <p className="mt-2 text-xs text-zinc-400">
              Uses Houston defaults ({HOUSTON_DEFAULTS.downPaymentPct}% down,{" "}
              {HOUSTON_DEFAULTS.mortgageRatePct}% rate, {HOUSTON_DEFAULTS.annualTaxRatePct}%
              effective tax).
              {tax ? " Actual HCAD tax used for this property." : ""}
            </p>
          </Section>
        )}

        {score && rent && assumptions && (
          <Section title="Monthly cash flow breakdown">
            <CashFlowBreakdown
              listPriceCents={property.listPriceCents}
              monthlyRentCents={rent.estimatedRentCents}
              annualTaxCents={tax?.annualTaxCents}
              assumptions={assumptions}
            />
          </Section>
        )}

        {tax && (
          <Section title="HCAD / tax record">
            <KeyValue
              rows={[
                ["Assessed value", fmtMoney(tax.assessedValueCents)],
                ["Annual tax", fmtMoney(tax.annualTaxCents)],
                ["Owner", tax.ownerName ?? "—"],
                ["Owner mailing", tax.ownerMailingAddress ?? "—"],
                ["Tax year", tax.taxYear?.toString() ?? "—"],
                ["Delinquent", tax.delinquent ? "Yes" : "No"],
              ]}
            />
          </Section>
        )}

        {assumptions && (
          <Section title="Assumptions used">
            <KeyValue
              rows={[
                ["Down payment", `${assumptions.downPaymentPct}%`],
                ["Mortgage rate", `${assumptions.mortgageRatePct}%`],
                ["Loan term", `${assumptions.loanTermYears} years`],
                ["Vacancy", `${assumptions.vacancyPct}%`],
                ["Maintenance", `${assumptions.maintenancePct}%`],
                ["Property mgmt", `${assumptions.propertyMgmtPct}%`],
                ["Closing costs", `${assumptions.closingCostPct}%`],
                ["Annual insurance", fmtMoney(assumptions.annualInsuranceCents)],
                ["Effective tax rate", `${assumptions.annualTaxRatePct}%`],
              ]}
            />
          </Section>
        )}

        {property.notes && (
          <Section title="Notes">
            <p className="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
              {property.notes}
            </p>
          </Section>
        )}
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
      ? "text-amber-600"
      : tone === "bad"
      ? "text-rose-600"
      : "";
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function KeyValue({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between border-b border-zinc-100 dark:border-zinc-800 py-1">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CashFlowBreakdown({
  listPriceCents,
  monthlyRentCents,
  annualTaxCents,
  assumptions,
}: {
  listPriceCents: number;
  monthlyRentCents: number;
  annualTaxCents?: number | null;
  assumptions: Assumptions;
}) {
  // Recompute the components for display so we can show the math, not just totals.
  const downCents = Math.round(listPriceCents * (assumptions.downPaymentPct / 100));
  const loanCents = listPriceCents - downCents;
  const r = assumptions.mortgageRatePct / 100 / 12;
  const n = assumptions.loanTermYears * 12;
  const mortgage =
    r === 0 ? loanCents / n : (loanCents * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  const tax =
    (annualTaxCents ?? Math.round(listPriceCents * (assumptions.annualTaxRatePct / 100))) / 12;
  const insurance = assumptions.annualInsuranceCents / 12;
  const vacancy = monthlyRentCents * (assumptions.vacancyPct / 100);
  const maintenance = monthlyRentCents * (assumptions.maintenancePct / 100);
  const mgmt = monthlyRentCents * (assumptions.propertyMgmtPct / 100);
  const total = mortgage + tax + insurance + vacancy + maintenance + mgmt;
  const cashFlow = monthlyRentCents - total;

  const rows: [string, number, "in" | "out"][] = [
    ["Gross rent", monthlyRentCents, "in"],
    ["Mortgage (P&I)", -mortgage, "out"],
    ["Property tax", -tax, "out"],
    ["Insurance", -insurance, "out"],
    ["Vacancy reserve", -vacancy, "out"],
    ["Maintenance reserve", -maintenance, "out"],
    ...(mgmt > 0 ? ([["Property mgmt", -mgmt, "out"]] as [string, number, "in" | "out"][]) : []),
  ];

  return (
    <div className="text-sm">
      <table className="w-full">
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map(([label, cents]) => (
            <tr key={label}>
              <td className="py-1.5 text-zinc-600 dark:text-zinc-400">{label}</td>
              <td
                className={`py-1.5 text-right tabular-nums ${
                  cents < 0 ? "text-rose-600" : "text-emerald-600"
                }`}
              >
                {fmtMoneyDetailed(Math.round(cents))}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-zinc-300 dark:border-zinc-700">
            <td className="py-2 font-semibold">Net monthly cash flow</td>
            <td
              className={`py-2 text-right font-semibold tabular-nums ${
                cashFlow < 0 ? "text-rose-600" : "text-emerald-600"
              }`}
            >
              {fmtMoneyDetailed(Math.round(cashFlow))}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
