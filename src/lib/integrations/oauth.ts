import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Provider } from "@/generated/prisma/enums";

import { optionalEnv, requireEnv } from "../env";
import { providerSlug } from "./providers";

/**
 * The parts of the OAuth handshake that are ours rather than any provider's:
 * where the callback lands, and how the callback proves it belongs to the
 * browser that started the flow.
 */

export const OAUTH_STATE_COOKIE = "integration_oauth_state";

/** A connect attempt should be finished in a couple of minutes, not tomorrow. */
export const OAUTH_STATE_MAX_AGE_SECONDS = 600;

const STATE_BYTES = 32;

/**
 * The app's public origin.
 *
 * Redirect URIs must match what is registered with each provider byte for byte,
 * so this comes from configuration rather than the incoming request — a
 * Host header is attacker-controlled and would make the redirect URI a
 * forgery target.
 */
export function appUrl(): string {
  return optionalEnv("APP_URL") ?? requireEnv("BETTER_AUTH_URL");
}

export function integrationRedirectUri(provider: Provider): string {
  return new URL(
    `/api/integrations/${providerSlug(provider)}/callback`,
    appUrl(),
  ).toString();
}

/** Absolute URL for a path in this app, for redirect responses. */
export function appPath(
  path: string,
  query: Record<string, string> = {},
): string {
  const url = new URL(path, appUrl());
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export interface OAuthStateCookie {
  /** Sent to the provider and echoed back on the callback. */
  state: string;
  /** Stored in the cookie: binds the state to the provider it was minted for. */
  value: string;
}

export function createOAuthState(provider: Provider): OAuthStateCookie {
  const state = randomBytes(STATE_BYTES).toString("base64url");
  return { state, value: `${provider}:${state}` };
}

/**
 * True when the callback's state matches the cookie minted for this provider.
 *
 * Constant-time comparison so the check cannot be turned into an oracle, and the
 * provider is part of the cookie so a state issued for Linear cannot complete a
 * Notion connection.
 */
export function verifyOAuthState(input: {
  cookieValue: string | undefined;
  provider: Provider;
  state: string | null;
}): boolean {
  if (!input.cookieValue || !input.state) return false;

  const expected = Buffer.from(`${input.provider}:${input.state}`, "utf8");
  const actual = Buffer.from(input.cookieValue, "utf8");
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}

/** Cookie attributes for the state cookie — httpOnly, short-lived, same-site. */
export function stateCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Lax, not Strict: the cookie must survive the provider's top-level
    // redirect back into the app, which Strict would drop.
    sameSite: "lax",
    secure: appUrl().startsWith("https://"),
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  };
}

/** Where every connect attempt ends up, success or failure. */
export const INTEGRATIONS_PATH = "/dashboard/integrations";

/**
 * Why a connect attempt failed, as a code the Integrations page turns into a
 * sentence. Codes rather than messages in the URL: the page owns the wording,
 * and no provider text is reflected into the browser.
 */
export type ConnectErrorCode =
  | "unknown_provider"
  | "not_configured"
  | "denied"
  | "invalid_state"
  | "exchange_failed";
