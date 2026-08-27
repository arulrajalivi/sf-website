import { NextResponse } from "next/server";

import {
  INTEGRATIONS_PATH,
  OAUTH_STATE_COOKIE,
  appPath,
  createOAuthState,
  integrationRedirectUri,
  stateCookieOptions,
} from "@/lib/integrations/oauth";
import {
  parseProviderSlug,
  providerCredentials,
  providerDefinition,
} from "@/lib/integrations/providers";
import { SIGN_IN_PATH, getCurrentSession } from "@/lib/session";

/**
 * Starts an OAuth connect flow: mint state, park it in an httpOnly cookie, and
 * send the browser to the provider's consent screen.
 *
 * A GET that redirects (rather than a POST returning a URL) is what lets the
 * Integrations page use a plain link and keeps the whole handshake server-side —
 * no client code ever sees a client id, a code, or a token.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.redirect(appPath(SIGN_IN_PATH));
  }

  const provider = parseProviderSlug((await params).provider);
  if (!provider) {
    return NextResponse.redirect(
      appPath(INTEGRATIONS_PATH, { error: "unknown_provider" }),
    );
  }

  const definition = providerDefinition(provider);
  const credentials = providerCredentials(definition);
  if (!credentials) {
    // The app is not registered with this provider yet. That is a deployment
    // state, not a user error, so it lands back on the page with an explanation
    // rather than as a 500.
    return NextResponse.redirect(
      appPath(INTEGRATIONS_PATH, {
        error: "not_configured",
        provider: definition.label,
      }),
    );
  }

  const { state, value } = createOAuthState(provider);
  const response = NextResponse.redirect(
    definition.authorizeUrl({
      credentials,
      redirectUri: integrationRedirectUri(provider),
      state,
    }),
  );
  response.cookies.set(OAUTH_STATE_COOKIE, value, stateCookieOptions());
  return response;
}
