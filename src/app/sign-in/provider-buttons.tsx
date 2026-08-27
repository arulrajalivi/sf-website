"use client";

import { useState } from "react";

import { signIn } from "@/lib/auth-client";
import type {
  ProviderAvailability,
  SocialProviderId,
} from "@/lib/auth-providers";

interface ProviderButtonsProps {
  providers: readonly ProviderAvailability[];
  /** Where the provider sends the user back to after a successful sign-in. */
  callbackURL: string;
  /** Error surfaced by an OAuth callback that came back through this page. */
  initialError?: string;
}

export function ProviderButtons({
  providers,
  callbackURL,
  initialError,
}: ProviderButtonsProps) {
  const [pending, setPending] = useState<SocialProviderId | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);

  async function start(provider: SocialProviderId) {
    setError(null);
    setPending(provider);
    try {
      const { error: signInError } = await signIn.social({
        provider,
        callbackURL,
        errorCallbackURL: "/sign-in",
      });
      if (signInError) {
        // The redirect never happened; say so instead of leaving a dead button.
        setError(
          signInError.message ?? "Sign-in could not be started. Please retry.",
        );
        setPending(null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Sign-in could not be started. Please retry.",
      );
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      ) : null}

      {providers.map(({ id, label, configured }) => (
        <button
          key={id}
          type="button"
          disabled={!configured || pending !== null}
          onClick={() => start(id)}
          className="border-edge hover:bg-surface flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending === id ? `Redirecting to ${label}…` : `Continue with ${label}`}
        </button>
      ))}

      {providers.some((provider) => !provider.configured) ? (
        <p className="text-muted text-xs">
          Greyed-out providers have no OAuth credentials in this environment yet.
        </p>
      ) : null}
    </div>
  );
}
