import type { Provider } from "@/generated/prisma/enums";

/**
 * The shape every connector speaks.
 *
 * Jira, Linear and Notion disagree about almost everything — form-encoded vs
 * JSON token bodies, Basic vs body credentials, whether a refresh token exists
 * at all, and where the workspace label lives. Those differences are each
 * provider module's problem; everything above this file sees one interface, so
 * adding a fourth provider is one new module plus one registry entry.
 */

/** Tokens as they come back from a provider, before encryption. */
export interface ProviderTokens {
  accessToken: string;
  /** Null for providers that issue non-expiring tokens (Linear, Notion). */
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

/** Who and where the connection points at, for the Integrations page. */
export interface ConnectionIdentity {
  /** e.g. "jane@acme.com" or the Jira site name. */
  accountLabel: string | null;
  /** Jira cloudId, Linear organization id, Notion workspace id. */
  workspaceRef: string | null;
}

/** The result of a completed authorization: tokens plus who they belong to. */
export interface ProviderConnection {
  tokens: ProviderTokens;
  identity: ConnectionIdentity;
}

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AuthorizeUrlInput {
  credentials: OAuthClientCredentials;
  redirectUri: string;
  state: string;
}

export interface ExchangeCodeInput {
  code: string;
  redirectUri: string;
  credentials: OAuthClientCredentials;
}

export interface RefreshTokensInput {
  refreshToken: string;
  credentials: OAuthClientCredentials;
}

export interface ProviderDefinition {
  provider: Provider;
  /** Name shown in the UI. */
  label: string;
  /** One line of what connecting this provider enables. */
  blurb: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /**
   * Absent when the provider's tokens cannot be refreshed. Its absence is what
   * makes "a 401 here is terminal" a fact about the provider rather than a
   * guess in the refresh path.
   */
  refreshTokens?: (input: RefreshTokensInput) => Promise<ProviderTokens>;
  authorizeUrl: (input: AuthorizeUrlInput) => string;
  /** Trades the callback code for tokens and resolves who they belong to. */
  exchangeCode: (input: ExchangeCodeInput) => Promise<ProviderConnection>;
}
