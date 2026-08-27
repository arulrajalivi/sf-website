import { getAuth } from "@/lib/auth";
import { cookiePreservingHtmlRedirect } from "@/lib/html-redirect";

/** Better Auth needs Node APIs (crypto, Prisma) — not the edge runtime. */
export const runtime = "nodejs";
/** Every auth request is request-specific; nothing here may be cached. */
export const dynamic = "force-dynamic";

async function GET(request: Request): Promise<Response> {
  const response = await getAuth().handler(request);
  // The hosting reverse proxy follows same-origin 3xx redirects internally
  // and strips Set-Cookie from what it forwards, so a browser navigating
  // through an OAuth callback never receives its session cookie. Riding the
  // cookie on a 200 HTML page (which the proxy passes through untouched)
  // keeps the redirect working without losing the session.
  return cookiePreservingHtmlRedirect(response, request);
}

async function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export { GET, POST };
