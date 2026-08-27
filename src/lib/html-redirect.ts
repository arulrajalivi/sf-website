/**
 * The Obvious hosting proxy in front of this app follows same-origin 3xx
 * redirects internally and strips every Set-Cookie header from the response
 * it ultimately forwards to the browser. Better Auth's OAuth callback relies
 * on a 302 + Set-Cookie to hand the browser its session cookie, so that
 * cookie never arrives and the user bounces straight back to sign-in.
 *
 * The proxy passes 200 responses through untouched, so the fix rides the
 * cookies on a 200 HTML page that redirects the browser itself (via
 * `<meta http-equiv="refresh">` and a script fallback) instead of relying on
 * an HTTP-level redirect.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Escapes a string for safe use inside an HTML attribute value. */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildRedirectHtml(location: string): string {
  const attributeSafeLocation = escapeHtmlAttribute(location);
  const scriptSafeLocation = JSON.stringify(location);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${attributeSafeLocation}"><script>window.location.replace(${scriptSafeLocation})</script></head><body></body></html>`;
}

/**
 * Converts a browser-navigation 3xx response into a 200 HTML page that
 * carries the same Set-Cookie headers and redirects client-side, so a
 * reverse proxy that strips Set-Cookie on followed redirects can't drop the
 * session cookie. Every other response (non-redirect, non-browser-navigation,
 * or missing a Location header) is returned unchanged.
 */
export function cookiePreservingHtmlRedirect(
  response: Response,
  request: Request,
): Response {
  const isBrowserNavigation = (request.headers.get("accept") ?? "").includes(
    "text/html",
  );
  if (!REDIRECT_STATUSES.has(response.status) || !isBrowserNavigation) {
    return response;
  }

  const location = response.headers.get("location");
  if (!location) {
    return response;
  }

  const headers = new Headers();
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");

  return new Response(buildRedirectHtml(location), { status: 200, headers });
}
