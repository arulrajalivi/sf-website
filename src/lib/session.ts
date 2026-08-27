import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "./auth";

/** Where an unauthenticated visitor is sent. */
export const SIGN_IN_PATH = "/sign-in";

type SessionResult = Awaited<
  ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>
>;

export type AuthenticatedSession = NonNullable<SessionResult>;

/**
 * The session for the incoming request, or null when there is none.
 * Reads the session row from Postgres via the request's cookies — a revoked or
 * expired session is therefore rejected on the very next request.
 */
export async function getCurrentSession(): Promise<AuthenticatedSession | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session ?? null;
}

/**
 * Session or bust: the single guard every authenticated surface calls. Keeping
 * the redirect here (rather than in each page) is what makes "unauthenticated
 * access redirects to sign-in" a property of the app instead of a convention
 * each new page has to remember.
 */
export async function requireSession(): Promise<AuthenticatedSession> {
  const session = await getCurrentSession();
  if (!session) {
    redirect(SIGN_IN_PATH);
  }
  return session;
}
