"use client";

import { useState, type ReactElement } from "react";

import { signIn } from "@/lib/auth-client";
import type {
  ProviderAvailability,
  SocialProviderId,
} from "@/lib/auth-providers";

/**
 * Brand marks for the sign-in buttons, inlined as SVG so the page makes no
 * external requests and the icons stay crisp at any DPI. Google and Microsoft
 * carry their fixed brand colors; GitHub uses `currentColor` so the octocat
 * tracks the button text color in both light and dark mode.
 */
export const PROVIDER_ICONS: Record<SocialProviderId, ReactElement> = {
  google: (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.09-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.05-3.72 1.05-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.07.56 4.21 1.65l3.16-3.16A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  ),
  microsoft: (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 23 23"
      className="h-5 w-5 shrink-0"
    >
      <rect x="0" y="0" width="11" height="11" fill="#F25022" />
      <rect x="12" y="0" width="11" height="11" fill="#7FBA00" />
      <rect x="0" y="12" width="11" height="11" fill="#00A4EF" />
      <rect x="12" y="12" width="11" height="11" fill="#FFB900" />
    </svg>
  ),
  github: (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-5 w-5 shrink-0"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  ),
};

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
          {PROVIDER_ICONS[id]}
          <span>
            {pending === id
              ? `Redirecting to ${label}…`
              : `Continue with ${label}`}
          </span>
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
