import { describe, expect, it } from "vitest";

import { cookiePreservingHtmlRedirect } from "@/lib/html-redirect";

/**
 * The hosting reverse proxy follows same-origin 3xx redirects internally and
 * strips Set-Cookie from what it forwards, so a browser-navigated OAuth
 * callback never receives its session cookie. These tests pin down exactly
 * which responses get converted to a cookie-carrying 200 HTML page and which
 * pass through untouched.
 */

function browserRequest(): Request {
  return new Request("https://example.com/api/auth/callback/github", {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
}

function jsonRequest(): Request {
  return new Request("https://example.com/api/auth/callback/github", {
    headers: { accept: "application/json" },
  });
}

function redirectResponse(
  location: string | null,
  cookies: string[],
): Response {
  const headers = new Headers();
  if (location) headers.set("location", location);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

describe("cookiePreservingHtmlRedirect", () => {
  it("converts a browser-navigation 302 with cookies into a 200 HTML page carrying every cookie", async () => {
    const response = redirectResponse("/dashboard", [
      "__Secure-better-auth.session_token=abc123; Path=/; Secure; HttpOnly",
      "__Secure-better-auth.state=xyz789; Path=/; Secure; HttpOnly",
    ]);

    const result = cookiePreservingHtmlRedirect(response, browserRequest());

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(result.headers.getSetCookie()).toEqual([
      "__Secure-better-auth.session_token=abc123; Path=/; Secure; HttpOnly",
      "__Secure-better-auth.state=xyz789; Path=/; Secure; HttpOnly",
    ]);
    const body = await result.text();
    expect(body).toContain("/dashboard");
  });

  it("passes a non-browser (fetch/JSON) 302 through unchanged", () => {
    const response = redirectResponse("/dashboard", [
      "__Secure-better-auth.session_token=abc123",
    ]);

    const result = cookiePreservingHtmlRedirect(response, jsonRequest());

    expect(result).toBe(response);
  });

  it("passes a 200 JSON response through unchanged", () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = cookiePreservingHtmlRedirect(response, browserRequest());

    expect(result).toBe(response);
  });

  it("passes a browser-navigation 302 with no Location header through unchanged", () => {
    const response = redirectResponse(null, [
      "__Secure-better-auth.session_token=abc123",
    ]);

    const result = cookiePreservingHtmlRedirect(response, browserRequest());

    expect(result).toBe(response);
  });
});
