import type { Provider } from "@/generated/prisma/enums";

import { decryptToken } from "../crypto";
import { providerCredentials, providerDefinition } from "./providers";
import { markExpired, saveRefreshedTokens } from "./store";
import type { IntegrationRow } from "./store";

/**
 * The one path that hands a live access token to a provider call.
 *
 * The rule it enforces, from the spec's "token expired mid-push" state: a 401 is
 * survivable exactly once. Refresh, retry once, and if that still fails, flip the
 * integration to EXPIRED so the user is asked to reconnect instead of every later
 * push rediscovering the same dead token.
 */

/** The integration cannot be used and reconnecting is the only fix. */
export class IntegrationUnavailableError extends Error {
  readonly provider: Provider;
  readonly reason: "expired" | "not-connected" | "not-configured";

  constructor(input: {
    provider: Provider;
    reason: "expired" | "not-connected" | "not-configured";
    message: string;
  }) {
    super(input.message);
    this.name = "IntegrationUnavailableError";
    this.provider = input.provider;
    this.reason = input.reason;
  }
}

/** A provider call, given a valid access token. */
export type AuthorizedRequest = (accessToken: string) => Promise<Response>;

/** Refresh this far ahead of the stated expiry rather than waiting for a 401. */
const EXPIRY_SKEW_MS = 60_000;

function isExpiring(row: IntegrationRow, now: Date): boolean {
  return row.expiresAt !== null && row.expiresAt.getTime() - EXPIRY_SKEW_MS <= now.getTime();
}

/**
 * Runs `request` with the integration's access token, refreshing when needed.
 *
 * Returns the provider's response — including error responses that are not 401,
 * which belong to the caller (a 404 project is not an auth problem). Throws
 * IntegrationUnavailableError when the connection itself is dead.
 */
export async function withFreshToken(
  integration: IntegrationRow,
  request: AuthorizedRequest,
  now: Date = new Date(),
): Promise<Response> {
  if (integration.status !== "CONNECTED" || !integration.accessTokenEnc) {
    throw new IntegrationUnavailableError({
      provider: integration.provider,
      reason: integration.status === "EXPIRED" ? "expired" : "not-connected",
      message: `${integration.provider} is not connected — reconnect it to continue.`,
    });
  }

  let accessToken = decryptToken(integration.accessTokenEnc);

  // Pre-emptive refresh: a token we already know is past its expiry costs a
  // guaranteed-failing round trip if we send it anyway.
  if (isExpiring(integration, now) && canRefresh(integration)) {
    accessToken = await refreshOrExpire(integration);
  }

  const response = await request(accessToken);
  if (response.status !== 401) return response;

  if (!canRefresh(integration)) {
    await markExpired(integration.id);
    throw new IntegrationUnavailableError({
      provider: integration.provider,
      reason: "expired",
      message:
        `${integration.provider} rejected the stored token and does not support ` +
        "refresh — reconnect the integration.",
    });
  }

  const refreshedToken = await refreshOrExpire(integration);
  const retried = await request(refreshedToken);
  if (retried.status !== 401) return retried;

  // A refreshed token that is *still* rejected is not a token problem.
  await markExpired(integration.id);
  throw new IntegrationUnavailableError({
    provider: integration.provider,
    reason: "expired",
    message: `${integration.provider} rejected a freshly refreshed token — reconnect the integration.`,
  });
}

function canRefresh(integration: IntegrationRow): boolean {
  const definition = providerDefinition(integration.provider);
  return Boolean(definition.refreshTokens && integration.refreshTokenEnc);
}

/**
 * Refreshes and persists, or marks the integration EXPIRED and throws.
 *
 * Every failure mode lands in the same place on purpose — a revoked grant, a
 * rotated client secret and a provider outage are indistinguishable from here,
 * and all three leave the user with the same next step.
 */
async function refreshOrExpire(integration: IntegrationRow): Promise<string> {
  const definition = providerDefinition(integration.provider);
  const credentials = providerCredentials(definition);

  if (!definition.refreshTokens || !integration.refreshTokenEnc) {
    await markExpired(integration.id);
    throw new IntegrationUnavailableError({
      provider: integration.provider,
      reason: "expired",
      message: `${integration.provider} has no refresh token on file — reconnect the integration.`,
    });
  }

  if (!credentials) {
    // Not the user's fault and not recoverable by reconnecting: leave the row
    // alone so the connection survives the deploy that forgot the secret.
    throw new IntegrationUnavailableError({
      provider: integration.provider,
      reason: "not-configured",
      message:
        `${definition.clientIdEnv} / ${definition.clientSecretEnv} are not set, ` +
        `so the ${integration.provider} token cannot be refreshed.`,
    });
  }

  try {
    const tokens = await definition.refreshTokens({
      refreshToken: decryptToken(integration.refreshTokenEnc),
      credentials,
    });
    await saveRefreshedTokens({ integrationId: integration.id, tokens });
    return tokens.accessToken;
  } catch (cause) {
    await markExpired(integration.id);
    throw new IntegrationUnavailableError({
      provider: integration.provider,
      reason: "expired",
      message:
        `Refreshing the ${integration.provider} token failed (${describe(cause)}) — ` +
        "reconnect the integration.",
    });
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
