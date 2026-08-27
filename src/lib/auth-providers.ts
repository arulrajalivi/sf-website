/**
 * Which social sign-in providers this deployment can actually complete.
 *
 * Credentials for the three login providers arrive per environment and are not
 * all present at once. Rather than render a button that dead-ends in an OAuth
 * error, the sign-in page asks this module what is configured and renders the
 * rest as unavailable.
 *
 * `resolveSocialProviders` is pure — it takes an env-shaped record instead of
 * reading `process.env` — so the configured / partially-configured / absent
 * cases are all directly testable.
 */

export const SOCIAL_PROVIDER_IDS = ["google", "microsoft", "github"] as const;

export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

export interface SocialProviderDescriptor {
  id: SocialProviderId;
  /** Label shown on the sign-in button. */
  label: string;
  /** Env var holding the OAuth client id. */
  idEnvVar: string;
  /** Env var holding the OAuth client secret. */
  secretEnvVar: string;
}

export const SOCIAL_PROVIDERS: readonly SocialProviderDescriptor[] = [
  {
    id: "google",
    label: "Google",
    idEnvVar: "AUTH_GOOGLE_ID",
    secretEnvVar: "AUTH_GOOGLE_SECRET",
  },
  {
    id: "microsoft",
    label: "Microsoft 365",
    idEnvVar: "AUTH_MICROSOFT_ID",
    secretEnvVar: "AUTH_MICROSOFT_SECRET",
  },
  {
    id: "github",
    label: "GitHub",
    idEnvVar: "AUTH_GITHUB_ID",
    secretEnvVar: "AUTH_GITHUB_SECRET",
  },
] as const;

export interface ProviderAvailability {
  id: SocialProviderId;
  label: string;
  configured: boolean;
}

interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/** Better Auth's `socialProviders` option, built from the environment. */
export interface ResolvedSocialProviders {
  google?: ProviderCredentials;
  microsoft?: ProviderCredentials & { tenantId: string };
  github?: ProviderCredentials;
}

type EnvRecord = Record<string, string | undefined>;

function credentials(
  env: EnvRecord,
  descriptor: SocialProviderDescriptor,
): ProviderCredentials | undefined {
  const clientId = env[descriptor.idEnvVar];
  const clientSecret = env[descriptor.secretEnvVar];
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

/**
 * A provider is included only when both halves of its credential pair are set.
 * Half-configured is treated as unconfigured: an OAuth exchange with a missing
 * secret fails after the user has already left the app, which is the worst
 * place to discover the problem.
 */
export function resolveSocialProviders(env: EnvRecord): ResolvedSocialProviders {
  const resolved: ResolvedSocialProviders = {};

  for (const descriptor of SOCIAL_PROVIDERS) {
    const pair = credentials(env, descriptor);
    if (!pair) continue;

    if (descriptor.id === "microsoft") {
      resolved.microsoft = {
        ...pair,
        // "common" accepts any Entra tenant plus personal Microsoft accounts.
        tenantId: env.AUTH_MICROSOFT_TENANT_ID ?? "common",
      };
      continue;
    }

    resolved[descriptor.id] = pair;
  }

  return resolved;
}

/** All three providers, each flagged with whether it can complete a sign-in. */
export function listProviderAvailability(env: EnvRecord): ProviderAvailability[] {
  const resolved = resolveSocialProviders(env);
  return SOCIAL_PROVIDERS.map(({ id, label }) => ({
    id,
    label,
    configured: resolved[id] !== undefined,
  }));
}
