import { requireSession } from "@/lib/session";

/** Guarded by the session cookie on every request — never prerendered. */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSession();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-3 px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="text-muted text-sm">
        Signed in as {session.user.email}.
      </p>
    </main>
  );
}
