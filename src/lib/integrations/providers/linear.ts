import { z } from "zod";

import { expiresAtFrom, normalizeScope, requestJson } from "../http";
import type {
  AuthorizeUrlInput,
  ExchangeCodeInput,
  ProviderConnection,
  ProviderDefinition,
} from "../types";

/**
 * Linear OAuth 2.0.
 *
 * Linear issues a long-lived access token and no refresh token, so this module
 * deliberately has no `refreshTokens`: a 401 from Linear means the user revoked
 * access, and the only honest recovery is to flip the integration to EXPIRED and
 * ask them to reconnect (see ../tokens.ts).
 *
 * The token response carries no identity, so the workspace label comes from one
 * GraphQL call against `viewer` and `organization`.
 */

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

const SCOPES = ["read", "write"] as const;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  // Linear has answered with both a string and a list across API versions.
  scope: z.union([z.string(), z.array(z.string())]).optional(),
});

const ViewerResponse = z.object({
  data: z.object({
    viewer: z
      .object({ email: z.string().nullish(), name: z.string().nullish() })
      .nullish(),
    organization: z
      .object({ id: z.string().nullish(), name: z.string().nullish() })
      .nullish(),
  }),
});

const VIEWER_QUERY =
  "query ConnectedAccount { viewer { email name } organization { id name } }";

export const linearProvider: ProviderDefinition = {
  provider: "LINEAR",
  label: "Linear",
  blurb: "Create Linear issues for each story and task in a draft.",
  clientIdEnv: "INTEGRATION_LINEAR_CLIENT_ID",
  clientSecretEnv: "INTEGRATION_LINEAR_CLIENT_SECRET",

  authorizeUrl({ credentials, redirectUri, state }: AuthorizeUrlInput): string {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(","),
      state,
      // Issues are created as the signed-in user rather than as an app bot, so
      // they carry a real author in Linear's UI.
      actor: "user",
    }).toString();
    return url.toString();
  },

  async exchangeCode({
    code,
    redirectUri,
    credentials,
  }: ExchangeCodeInput): Promise<ProviderConnection> {
    const token = await requestJson({
      provider: "LINEAR",
      operation: "authorization code exchange",
      url: TOKEN_URL,
      schema: TokenResponse,
      init: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      },
    });

    const viewer = await requestJson({
      provider: "LINEAR",
      operation: "viewer lookup",
      url: GRAPHQL_URL,
      schema: ViewerResponse,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token.access_token}`,
        },
        body: JSON.stringify({ query: VIEWER_QUERY }),
      },
    });

    const organization = viewer.data.organization;
    return {
      tokens: {
        accessToken: token.access_token,
        refreshToken: null,
        expiresAt: expiresAtFrom(token.expires_in),
        scope: normalizeScope(token.scope),
      },
      identity: {
        accountLabel:
          viewer.data.viewer?.email ??
          viewer.data.viewer?.name ??
          organization?.name ??
          null,
        workspaceRef: organization?.id ?? null,
      },
    };
  },
};
