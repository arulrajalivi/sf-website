import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests for the authenticated surface.
 *
 * Better Auth and Prisma are replaced by a token→session map so the assertions
 * are about *our* rules — who gets redirected, what the page shows, and whether
 * a revoked session is still honoured — rather than about a library or a live
 * database.
 */

const { RedirectError } = vi.hoisted(() => {
  class RedirectError extends Error {
    readonly path: string;
    constructor(path: string) {
      super(`NEXT_REDIRECT:${path}`);
      this.name = "RedirectError";
      this.path = path;
    }
  }
  return { RedirectError };
});

const state = vi.hoisted(() => ({
  cookieHeader: undefined as string | undefined,
  sessionsByToken: new Map<string, unknown>(),
  getSessionCalls: 0,
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(state.cookieHeader ? { cookie: state.cookieHeader } : {}),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new RedirectError(path);
  },
}));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        state.getSessionCalls += 1;
        const token = /session_token=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1];
        return (token && state.sessionsByToken.get(token)) || null;
      },
    },
  }),
}));

const { SIGN_IN_PATH, getCurrentSession } = await import("@/lib/session");
const DashboardPage = (await import("@/app/dashboard/page")).default;

const SESSION = {
  session: { id: "sess_1", token: "valid-token", userId: "user_1" },
  user: { id: "user_1", email: "jane@acme.com", name: "Jane" },
};

beforeEach(() => {
  state.cookieHeader = undefined;
  state.sessionsByToken = new Map([["valid-token", SESSION]]);
  state.getSessionCalls = 0;
});

describe("GET /dashboard", () => {
  it("redirects an unauthenticated request to sign-in", async () => {
    await expect(DashboardPage()).rejects.toMatchObject({
      path: SIGN_IN_PATH,
    });
  });

  it("redirects when the cookie carries an unknown session token", async () => {
    state.cookieHeader = "better-auth.session_token=forged-token";

    await expect(DashboardPage()).rejects.toMatchObject({
      path: SIGN_IN_PATH,
    });
  });

  it("renders the dashboard for a request carrying a valid session", async () => {
    state.cookieHeader = "better-auth.session_token=valid-token";

    const markup = renderToStaticMarkup(await DashboardPage());

    expect(markup).toContain("jane@acme.com");
  });
});

describe("session persistence", () => {
  it("keeps the same session across sequential requests with the same cookie", async () => {
    state.cookieHeader = "better-auth.session_token=valid-token";

    const first = await getCurrentSession();
    const second = await getCurrentSession();

    expect(first?.user.email).toBe("jane@acme.com");
    expect(second?.user.email).toBe("jane@acme.com");
  });

  it("re-reads the session store on every request so revocation takes effect at once", async () => {
    state.cookieHeader = "better-auth.session_token=valid-token";
    expect(await getCurrentSession()).not.toBeNull();

    state.sessionsByToken.delete("valid-token");

    expect(await getCurrentSession()).toBeNull();
    expect(state.getSessionCalls).toBe(2);
  });

  it("reports no session when the request carries no cookie", async () => {
    expect(await getCurrentSession()).toBeNull();
  });
});
