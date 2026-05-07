import Link from "next/link";
import { importHarAction } from "./actions";

export default async function HarImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; url?: string }>;
}) {
  const { error, url: prefillUrl = "" } = await searchParams;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-2xl mx-auto px-6 py-5">
          <Link href="/add" className="text-sm text-zinc-500 hover:underline">
            ← Manual entry
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Import from HAR.com</h1>
          <p className="text-sm text-zinc-500">
            Paste a listing URL to auto-fill price, address, and specs. You&apos;ll add
            a rent estimate on the next screen to trigger scoring.
          </p>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-4">
        {error && (
          <div className="rounded-md bg-rose-50 dark:bg-rose-950 border border-rose-200 dark:border-rose-800 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            {decodeURIComponent(error)}
          </div>
        )}

        <form
          action={importHarAction}
          className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4"
        >
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              HAR.com listing URL <span className="text-rose-500">*</span>
            </span>
            <input
              name="url"
              type="url"
              required
              defaultValue={prefillUrl}
              placeholder="https://www.har.com/homedetail/..."
              className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </label>

          <div className="flex items-center justify-end gap-3">
            <Link
              href="/add"
              className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Cancel
            </Link>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300"
            >
              Fetch &amp; import
            </button>
          </div>
        </form>

        <p className="text-xs text-zinc-400">
          If the import fails (HAR requires login for some data), use the{" "}
          <Link href="/add" className="underline">
            manual entry form
          </Link>{" "}
          instead.
        </p>
      </main>
    </div>
  );
}
