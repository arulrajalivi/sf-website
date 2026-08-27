import Link from "next/link";

import { requireSession } from "@/lib/session";

import { DASHBOARD_NAV_ITEMS } from "./nav-items";

/** Guarded by the session cookie on every request — never prerendered. */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSession();

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted text-sm">
          Signed in as {session.user.email}.
        </p>
      </header>

      <ul className="grid gap-3 sm:grid-cols-3">
        {DASHBOARD_NAV_ITEMS.map(({ href, label, description }) => (
          <li key={href}>
            <Link
              href={href}
              className="border-edge hover:bg-surface flex h-full flex-col gap-1.5 rounded-lg border p-4 transition-colors"
            >
              <span className="text-sm font-medium">{label}</span>
              <span className="text-muted text-xs">{description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
