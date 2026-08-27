"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { signOut } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setError(null);
    setPending(true);
    try {
      await signOut();
      // refresh() re-runs the server guard, which sends us to /sign-in.
      router.refresh();
    } catch (cause) {
      // A failed sign-out leaves a live session; saying so beats a dead button.
      setError(
        cause instanceof Error ? cause.message : "Sign-out failed. Please retry.",
      );
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleSignOut}
        disabled={pending}
        className="border-edge hover:bg-surface rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
