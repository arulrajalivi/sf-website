import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import type { ConnectErrorCode } from "@/lib/integrations/oauth";
import {
  INTEGRATIONS_PATH,
  OAUTH_STATE_COOKIE,
  appPath,
  integrationRedirectUri,
  verifyOAuthState,
} from "@/lib/integrations/oauth";
import {
  parseProviderSlug,
  providerCredentials,
  providerDefinition,
} from "@/lib/integrations/providers";
import { saveConnection } from "@/lib/integrations/store";
import { SIGN_IN_PATH, getCurrentSession } from "@/lib/session";

/**
 * Finishes an OAuth connect flow: verify state, exchange the code, store the
 * encrypted tokens, and land the user back on the Integrations page.
 *
 * Every exit clears the state cookie. A single-use state that outlives its one
 * use is a replay window, and leaving it behind after a failure means the next
 * attempt is validated against a stale value.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.redirect(appPath(SIGN_IN_PATH));
  }

  const provider = parseProviderSlug((await params).provider);
  if (!provider) return failure("unknown_provider");

  const definition = providerDefinition(provider);
  const url = new URL(request.url);

  // The user pressed Cancel, or the provider refused the grant.
  if (url.searchParams.get("error")) {
    return failure("denied", definition.label);
  }

  const code = url.searchParams.get("code");
  const stateMatches = verifyOAuthState({
    cookieValue: request.cookies.get(OAUTH_STATE_COOKIE)?.value,
    provider,
    state: url.searchParams.get("state"),
  });
  if (!code || !stateMatches) {
    return failure("invalid_state", definition.label);
  }

  const credentials = providerCredentials(definition);
  if (!credentials) return failure("not_configured", definition.label);

  try {
    const connection = await definition.exchangeCode({
      code,
      redirectUri: integrationRedirectUri(provider),
      credentials,
    });

    await saveConnection({
      userId: session.user.id,
      provider,
      tokens: connection.tokens,
      identity: connection.identity,
    });
  } catch (cause) {
    // Surfaced, never swallowed: the user gets a code they can act on and the
    // server log keeps the provider's own words for whoever debugs it.
    console.error(
      `[integrations] ${provider} code exchange failed:`,
      cause instanceof Error ? cause.message : cause,
    );
    return failure("exchange_failed", definition.label);
  }

  return redirectToIntegrations({ connected: definition.label });
}

function failure(
  error: ConnectErrorCode,
  providerLabel?: string,
): NextResponse {
  return redirectToIntegrations(
    providerLabel ? { error, provider: providerLabel } : { error },
  );
}

function redirectToIntegrations(
  query: Record<string, string>,
): NextResponse {
  const response = NextResponse.redirect(appPath(INTEGRATIONS_PATH, query));
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}
