import type { Provider } from "@/generated/prisma/enums";

import { optionalEnv } from "../../env";
import type { OAuthClientCredentials, ProviderDefinition } from "../types";
import { jiraProvider } from "./jira";
import { linearProvider } from "./linear";
import { notionProvider } from "./notion";

/**
 * The connector registry: the only place that knows which providers exist.
 * The UI, the routes and the refresh path all iterate this record, so a fourth
 * provider is one module and one entry here — never a fourth branch elsewhere.
 */
export const PROVIDER_DEFINITIONS: Record<Provider, ProviderDefinition> = {
  JIRA: jiraProvider,
  LINEAR: linearProvider,
  NOTION: notionProvider,
};

/** Providers in the order the Integrations page lists them. */
export const PROVIDERS: readonly Provider[] = Object.keys(
  PROVIDER_DEFINITIONS,
) as Provider[];

export function providerDefinition(provider: Provider): ProviderDefinition {
  return PROVIDER_DEFINITIONS[provider];
}

/** URL segment for a provider: JIRA ⇄ "jira". */
export function providerSlug(provider: Provider): string {
  return provider.toLowerCase();
}

/**
 * A URL segment back to a provider, or null.
 *
 * Returning null rather than throwing keeps "someone typed /api/integrations/
 * slack/connect" a 404 instead of a 500 — a bad URL is not a server fault.
 */
export function parseProviderSlug(slug: string): Provider | null {
  const candidate = slug.toUpperCase();
  return candidate in PROVIDER_DEFINITIONS ? (candidate as Provider) : null;
}

/**
 * The OAuth client credentials for a provider, or null when the app is not
 * registered with it yet.
 *
 * Null rather than a throw because unregistered is an expected state during
 * rollout: the Integrations page renders those providers as "not configured"
 * instead of offering a Connect button that can only fail.
 */
export function providerCredentials(
  definition: ProviderDefinition,
): OAuthClientCredentials | null {
  const clientId = optionalEnv(definition.clientIdEnv);
  const clientSecret = optionalEnv(definition.clientSecretEnv);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function isProviderConfigured(definition: ProviderDefinition): boolean {
  return providerCredentials(definition) !== null;
}
