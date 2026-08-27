import { z } from "zod";

import { requestJson } from "../http";
import type {
  AuthorizeUrlInput,
  ExchangeCodeInput,
  ProviderConnection,
  ProviderDefinition,
} from "../types";

/**
 * Notion OAuth 2.0.
 *
 * Notion is the odd one out twice over: client credentials go in a Basic
 * Authorization header rather than the body, and the token response already
 * carries the workspace and the authorizing person — so no identity call
 * follows. Like Linear, Notion tokens do not expire and cannot be refreshed;
 * a 401 means the user removed the integration from their workspace.
 */

const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";

const TokenResponse = z.object({
  access_token: z.string().min(1),
  workspace_id: z.string().nullish(),
  workspace_name: z.string().nullish(),
  owner: z
    .object({
      user: z
        .object({
          name: z.string().nullish(),
          person: z.object({ email: z.string().nullish() }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export const notionProvider: ProviderDefinition = {
  provider: "NOTION",
  label: "Notion",
  blurb: "Write each story to the connected Notion workspace as a page.",
  clientIdEnv: "INTEGRATION_NOTION_CLIENT_ID",
  clientSecretEnv: "INTEGRATION_NOTION_CLIENT_SECRET",

  authorizeUrl({ credentials, redirectUri, state }: AuthorizeUrlInput): string {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      response_type: "code",
      // "user" makes the grant belong to the person, so pages are created under
      // their access rather than an internal bot's.
      owner: "user",
      redirect_uri: redirectUri,
      state,
    }).toString();
    return url.toString();
  },

  async exchangeCode({
    code,
    redirectUri,
    credentials,
  }: ExchangeCodeInput): Promise<ProviderConnection> {
    const token = await requestJson({
      provider: "NOTION",
      operation: "authorization code exchange",
      url: TOKEN_URL,
      schema: TokenResponse,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthorization(
            credentials.clientId,
            credentials.clientSecret,
          ),
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      },
    });

    const person = token.owner?.user;
    return {
      tokens: {
        accessToken: token.access_token,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      },
      identity: {
        accountLabel:
          person?.person?.email ??
          person?.name ??
          token.workspace_name ??
          null,
        workspaceRef: token.workspace_id ?? null,
      },
    };
  },
};
