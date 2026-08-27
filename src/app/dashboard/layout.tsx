import type { ReactNode } from "react";

import { requireSession } from "@/lib/session";

import { DashboardNav } from "./dashboard-nav";
import { SignOutButton } from "./sign-out-button";

/** Session-dependent chrome; nothing under /dashboard is prerendered. */
export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Guards the chrome. Each page guards itself too — a layout is not a security
  // boundary in the App Router, and pages can be reached without re-rendering it.
  const session = await requireSession();

  return (
    <div className="min-h-dvh">
      <header className="border-edge border-b">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex flex-col gap-3">
            <span className="text-sm font-semibold tracking-tight">
              Integration Dashboard
            </span>
            <DashboardNav />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted text-sm">{session.user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
