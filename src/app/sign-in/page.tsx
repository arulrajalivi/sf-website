import { redirect } from "next/navigation";

import { listProviderAvailability } from "@/lib/auth-providers";
import { getCurrentSession } from "@/lib/session";

import { ProviderButtons } from "./provider-buttons";

/** Reads request cookies to detect an existing session — never prerendered. */
export const dynamic = "force-dynamic";

const DASHBOARD_PATH = "/dashboard";

interface SignInPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readError(
  params: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = params.error;
  if (!value) return undefined;
  const code = Array.isArray(value) ? value[0] : value;
  return `Sign-in did not complete (${code}). Please try again.`;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  // Someone already signed in has no business on this page.
  const session = await getCurrentSession();
  if (session) {
    redirect(DASHBOARD_PATH);
  }

  const providers = listProviderAvailability(process.env);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-muted text-sm">
          Use your work identity. The first sign-in creates your account — there
          is no separate sign-up.
        </p>
      </header>

      <ProviderButtons
        providers={providers}
        callbackURL={DASHBOARD_PATH}
        initialError={readError(await searchParams)}
      />
    </main>
  );
}
