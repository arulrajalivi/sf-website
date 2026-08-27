import { z } from "zod";

import { expiresAtFrom, normalizeScope, requestJson } from "../http";
import type {
  AuthorizeUrlInput,
  ExchangeCodeInput,
  ProviderConnection,
  ProviderDefinition,
  ProviderTokens,
  RefreshTokensInput,
} from "../types";

/**
 * Atlassian OAuth 2.0 (3LO) for Jira Cloud.
 *
 * Two Atlassian-specific facts shape this module:
 *  - `audience=api.atlassian.com` and the `offline_access` scope are what make
 *    the issued token usable against the REST API and refreshable at all.
 *  - The token says nothing about *which site* it can reach; the cloudId comes
 *    from a second call to accessible-resources, and it is what every later Jira
 *    API path is built from. Storing it at connect time is the difference
 *    between a push that knows its target and one that has to guess.
 */

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources";

const SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:me",
  "offline_access",
] as const;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});

const AccessibleResources = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    url: z.string().optional(),
  }),
);

function toTokens(
  response: z.infer<typeof TokenResponse>,
  fallbackRefreshToken: string | null = null,
): ProviderTokens {
  return {
    accessToken: response.access_token,
    // A rotating refresh token replaces the old one; Atlassian omits it only
    // when the previous one is still valid, so keep what we already had.
    refreshToken: response.refresh_token ?? fallbackRefreshToken,
    expiresAt: expiresAtFrom(response.expires_in),
    scope: normalizeScope(response.scope),
  };
}

async function requestTokens(
  operation: string,
  body: Record<string, string>,
  fallbackRefreshToken: string | null = null,
): Promise<ProviderTokens> {
  const response = await requestJson({
    provider: "JIRA",
    operation,
    url: TOKEN_URL,
    schema: TokenResponse,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  });
  return toTokens(response, fallbackRefreshToken);
}

export const jiraProvider: ProviderDefinition = {
  provider: "JIRA",
  label: "Jira",
  blurb: "Push stories and tasks into a Jira Cloud project as issues.",
  clientIdEnv: "INTEGRATION_JIRA_CLIENT_ID",
  clientSecretEnv: "INTEGRATION_JIRA_CLIENT_SECRET",

  authorizeUrl({ credentials, redirectUri, state }: AuthorizeUrlInput): string {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: credentials.clientId,
      scope: SCOPES.join(" "),
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      // Without consent the user is bounced straight back without a refresh
      // token on a re-authorization, which is precisely when we need one.
      prompt: "consent",
    }).toString();
    return url.toString();
  },

  async exchangeCode({
    code,
    redirectUri,
    credentials,
  }: ExchangeCodeInput): Promise<ProviderConnection> {
    const tokens = await requestTokens("authorization code exchange", {
      grant_type: "authorization_code",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const resources = await requestJson({
      provider: "JIRA",
      operation: "accessible-resources lookup",
      url: ACCESSIBLE_RESOURCES_URL,
      schema: AccessibleResources,
      init: {
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          accept: "application/json",
        },
      },
    });

    // A user with several Jira sites gets the first; site selection is a
    // separate decision the spec leaves to the push surface.
    const site = resources[0];
    return {
      tokens,
      identity: {
        accountLabel: site ? (site.name ?? site.url ?? null) : null,
        workspaceRef: site?.id ?? null,
      },
    };
  },

  async refreshTokens({
    refreshToken,
    credentials,
  }: RefreshTokensInput): Promise<ProviderTokens> {
    return requestTokens(
      "refresh token exchange",
      {
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: refreshToken,
      },
      refreshToken,
    );
  },
};
