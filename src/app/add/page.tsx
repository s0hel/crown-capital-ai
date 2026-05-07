import Link from "next/link";
import { addPropertyAction } from "./actions";
import { HOUSTON_DEFAULTS, fmtMoney } from "@/lib/scoring";

export default function AddPropertyPage() {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-3xl mx-auto px-6 py-5">
          <Link href="/" className="text-sm text-zinc-500 hover:underline">
            ← All leads
          </Link>
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Add property</h1>
            <Link
              href="/add/har"
              className="shrink-0 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Import from HAR.com ↗
            </Link>
          </div>
          <p className="text-sm text-zinc-500">
            Manual entry. Once added, the property is scored against Houston defaults
            ({HOUSTON_DEFAULTS.downPaymentPct}% down, {HOUSTON_DEFAULTS.mortgageRatePct}% rate,{" "}
            {HOUSTON_DEFAULTS.annualTaxRatePct}% effective tax,{" "}
            {fmtMoney(HOUSTON_DEFAULTS.annualInsuranceCents)}/yr insurance).
          </p>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-8">
        <form action={addPropertyAction} className="space-y-6">
          <Section title="Address">
            <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
              <Field label="Street" name="street" required className="sm:col-span-4" />
              <Field label="City" name="city" defaultValue="Houston" className="sm:col-span-3" />
              <Field label="ZIP" name="zip" required className="sm:col-span-3" />
            </div>
          </Section>

          <Section title="Property">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Field label="Beds" name="beds" type="number" />
              <Field label="Baths" name="baths" type="number" step="0.5" />
              <Field label="Sqft" name="sqft" type="number" />
              <Field label="Year built" name="yearBuilt" type="number" />
            </div>
          </Section>

          <Section title="Money">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label="List price ($)"
                name="listPrice"
                type="number"
                step="1"
                required
                placeholder="180000"
              />
              <Field
                label="Estimated monthly rent ($)"
                name="rent"
                type="number"
                step="1"
                required
                placeholder="1800"
              />
              <Field
                label="Annual tax ($)"
                name="annualTax"
                type="number"
                step="1"
                placeholder={`leave blank to use ${HOUSTON_DEFAULTS.annualTaxRatePct}%`}
              />
              <Field
                label="HCAD assessed value ($)"
                name="assessedValue"
                type="number"
                step="1"
                placeholder="optional"
              />
            </div>
          </Section>

          <Section title="Source">
            <div className="space-y-4">
              <Field
                label="Listing URL"
                name="sourceUrl"
                type="url"
                placeholder="https://har.com/..."
              />
              <Field label="Notes" name="notes" type="textarea" />
            </div>
          </Section>

          <div className="flex items-center justify-end gap-3">
            <Link
              href="/"
              className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Cancel
            </Link>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300"
            >
              Score & save
            </button>
          </div>
        </form>
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

function Field({
  label,
  name,
  type = "text",
  required,
  defaultValue,
  placeholder,
  className,
  step,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
  step?: string;
}) {
  const inputClass =
    "w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400";
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
        {required && <span className="text-rose-500"> *</span>}
      </span>
      {type === "textarea" ? (
        <textarea
          name={name}
          required={required}
          defaultValue={defaultValue}
          placeholder={placeholder}
          rows={3}
          className={`mt-1 ${inputClass}`}
        />
      ) : (
        <input
          name={name}
          type={type}
          required={required}
          defaultValue={defaultValue}
          placeholder={placeholder}
          step={step}
          className={`mt-1 ${inputClass}`}
        />
      )}
    </label>
  );
}
