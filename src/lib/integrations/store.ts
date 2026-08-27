import type { IntegrationModel } from "@/generated/prisma/models/Integration";
import type { Provider } from "@/generated/prisma/enums";

import { encryptOptionalToken, encryptToken } from "../crypto";
import { prisma } from "../prisma";
import type { ConnectionIdentity, ProviderTokens } from "./types";

/**
 * Every read and write of the integration table, in one module.
 *
 * Encryption happens here rather than at the call sites: a token that is written
 * anywhere else in the codebase is a bug you can find by grepping this file's
 * name, and no caller has to remember to encrypt.
 */

export type IntegrationRow = IntegrationModel;

/** What the UI needs, with no token material in the shape at all. */
export interface IntegrationSummary {
  provider: Provider;
  status: IntegrationRow["status"];
  accountLabel: string | null;
  workspaceRef: string | null;
  connectedAt: Date | null;
}

export async function listIntegrations(
  userId: string,
): Promise<IntegrationRow[]> {
  return prisma.integration.findMany({ where: { userId } });
}

export async function findIntegration(
  userId: string,
  provider: Provider,
): Promise<IntegrationRow | null> {
  return prisma.integration.findUnique({
    where: { userId_provider: { userId, provider } },
  });
}

/** A row reduced to what a page may render — tokens never leave this module. */
export function toSummary(row: IntegrationRow): IntegrationSummary {
  return {
    provider: row.provider,
    status: row.status,
    accountLabel: row.accountLabel,
    workspaceRef: row.workspaceRef,
    connectedAt: row.status === "CONNECTED" ? row.updatedAt : null,
  };
}

/**
 * Records a completed authorization.
 *
 * An upsert on (userId, provider) so reconnecting after an expiry replaces the
 * dead tokens in place instead of racing the unique constraint, and so a
 * previously DISCONNECTED row comes back CONNECTED rather than lingering.
 */
export async function saveConnection(input: {
  userId: string;
  provider: Provider;
  tokens: ProviderTokens;
  identity: ConnectionIdentity;
}): Promise<IntegrationRow> {
  const connection = {
    status: "CONNECTED" as const,
    accountLabel: input.identity.accountLabel,
    workspaceRef: input.identity.workspaceRef,
    accessTokenEnc: encryptToken(input.tokens.accessToken),
    refreshTokenEnc: encryptOptionalToken(input.tokens.refreshToken),
    expiresAt: input.tokens.expiresAt,
    scope: input.tokens.scope,
    lastRefreshedAt: new Date(),
  };

  return prisma.integration.upsert({
    where: { userId_provider: { userId: input.userId, provider: input.provider } },
    create: {
      userId: input.userId,
      provider: input.provider,
      ...connection,
    },
    update: connection,
  });
}

/** Stores tokens obtained by a refresh, leaving identity and status alone. */
export async function saveRefreshedTokens(input: {
  integrationId: string;
  tokens: ProviderTokens;
}): Promise<IntegrationRow> {
  return prisma.integration.update({
    where: { id: input.integrationId },
    data: {
      status: "CONNECTED",
      accessTokenEnc: encryptToken(input.tokens.accessToken),
      refreshTokenEnc: encryptOptionalToken(input.tokens.refreshToken),
      expiresAt: input.tokens.expiresAt,
      scope: input.tokens.scope,
      lastRefreshedAt: new Date(),
    },
  });
}

/**
 * The provider rejected our credentials and refresh did not recover them.
 * Tokens are cleared as well as flagged: keeping a token we know is dead only
 * invites a later code path to try it again.
 */
export async function markExpired(integrationId: string): Promise<void> {
  await prisma.integration.update({
    where: { id: integrationId },
    data: {
      status: "EXPIRED",
      accessTokenEnc: null,
      refreshTokenEnc: null,
      expiresAt: null,
    },
  });
}

/**
 * User-initiated disconnect: the row survives (history, and the unique slot),
 * every trace of the grant does not — including the label, so the page cannot
 * show a stale "Connected as jane@acme.com" next to a Not connected badge.
 */
export async function disconnectIntegration(
  userId: string,
  provider: Provider,
): Promise<void> {
  await prisma.integration.updateMany({
    where: { userId, provider },
    data: {
      status: "DISCONNECTED",
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accountLabel: null,
      workspaceRef: null,
      expiresAt: null,
      scope: null,
    },
  });
}
