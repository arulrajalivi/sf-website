import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The connect flow, end to end, with the three providers and Postgres replaced
 * by fakes.
 *
 * What is being asserted is *our* half of OAuth: that state is verified before a
 * code is spent, that what lands in the database is ciphertext rather than the
 * token the provider handed us, that a 401 costs exactly one refresh attempt,
 * and that a failed refresh leaves a row the UI can explain. None of that needs
 * a real Atlassian, and all of it breaks silently if it is only reviewed by eye.
 */

// Assigned, not defaulted: CI exports its own BETTER_AUTH_URL, and a redirect_uri
// assertion that silently adopts the ambient value passes locally and fails
// there. The suite owns every input it asserts on.
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.BETTER_AUTH_URL = "https://app.example.test";
delete process.env.APP_URL;
process.env.INTEGRATION_JIRA_CLIENT_ID = "jira-client";
process.env.INTEGRATION_JIRA_CLIENT_SECRET = "jira-secret";
process.env.INTEGRATION_LINEAR_CLIENT_ID = "linear-client";
process.env.INTEGRATION_LINEAR_CLIENT_SECRET = "linear-secret";
// Notion is deliberately left unconfigured: "the app is not registered with this
// provider yet" is a state this feature ships in, so it is a tested state.
delete process.env.INTEGRATION_NOTION_CLIENT_ID;
delete process.env.INTEGRATION_NOTION_CLIENT_SECRET;

const USER_ID = "user_1";

interface FakeRow {
  id: string;
  userId: string;
  provider: string;
  status: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accountLabel: string | null;
  workspaceRef: string | null;
  expiresAt: Date | null;
  scope: string | null;
  lastRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  nextId: 1,
}));

const session = vi.hoisted(() => ({ userId: "user_1" as string | null }));

vi.mock("@/lib/prisma", () => {
  function match(
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean {
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  return {
    prisma: {
      integration: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          db.rows.filter((row) => match(row, where)),
        findUnique: async ({
          where,
        }: {
          where: { userId_provider: { userId: string; provider: string } };
        }) =>
          db.rows.find((row) => match(row, where.userId_provider)) ?? null,
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { userId_provider: { userId: string; provider: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = db.rows.find((row) =>
            match(row, where.userId_provider),
          );
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          const row = {
            id: `integration_${db.nextId++}`,
            accountLabel: null,
            workspaceRef: null,
            accessTokenEnc: null,
            refreshTokenEnc: null,
            expiresAt: null,
            scope: null,
            lastRefreshedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
          db.rows.push(row);
          return row;
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = db.rows.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error(`no integration row ${where.id}`);
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const rows = db.rows.filter((row) => match(row, where));
          for (const row of rows) {
            Object.assign(row, data, { updatedAt: new Date() });
          }
          return { count: rows.length };
        },
      },
    },
  };
});

vi.mock("@/lib/session", () => ({
  SIGN_IN_PATH: "/sign-in",
  getCurrentSession: async () =>
    session.userId ? { user: { id: session.userId } } : null,
  requireSession: async () => {
    if (!session.userId) throw new Error("NEXT_REDIRECT:/sign-in");
    return { user: { id: session.userId } };
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { NextRequest } = await import("next/server");
const connectRoute = await import(
  "@/app/api/integrations/[provider]/connect/route"
);
const callbackRoute = await import(
  "@/app/api/integrations/[provider]/callback/route"
);
const { disconnectProviderAction } = await import(
  "@/app/dashboard/integrations/actions"
);
const { decryptToken } = await import("@/lib/crypto");
const { OAUTH_STATE_COOKIE } = await import("@/lib/integrations/oauth");
const { findIntegration } = await import("@/lib/integrations/store");
const { IntegrationUnavailableError, withFreshToken } = await import(
  "@/lib/integrations/tokens"
);

/** NextResponse, not Response — the tests read the state cookie off it. */
type RouteResponse = Awaited<ReturnType<typeof connectRoute.GET>>;

const JIRA_ACCESS = "jira-access-token-aaa";
const JIRA_REFRESH = "jira-refresh-token-bbb";
const LINEAR_ACCESS = "linear-access-token-ccc";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Routes fetches by URL so a test states what each endpoint answers, not when. */
function mockFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const handler = Object.entries(handlers).find(([prefix]) =>
      url.startsWith(prefix),
    )?.[1];
    if (!handler) throw new Error(`unexpected fetch to ${url}`);
    return handler();
  });
}

const JIRA_HANDLERS = {
  "https://auth.atlassian.com/oauth/token": () =>
    jsonResponse({
      access_token: JIRA_ACCESS,
      refresh_token: JIRA_REFRESH,
      expires_in: 3600,
      scope: "read:jira-work write:jira-work",
    }),
  "https://api.atlassian.com/oauth/token/accessible-resources": () =>
    jsonResponse([
      { id: "cloud-id-123", name: "Acme Jira", url: "https://acme.atlassian.net" },
    ]),
};

async function startConnect(slug: string): Promise<RouteResponse> {
  return connectRoute.GET(
    new NextRequest(`https://app.example.test/api/integrations/${slug}/connect`),
    { params: Promise.resolve({ provider: slug }) },
  );
}

/** Completes a callback with the state cookie the connect step minted. */
async function completeCallback(input: {
  slug: string;
  state: string;
  cookie: string | undefined;
  code?: string;
  error?: string;
}): Promise<RouteResponse> {
  const url = new URL(
    `https://app.example.test/api/integrations/${input.slug}/callback`,
  );
  if (input.error) url.searchParams.set("error", input.error);
  else url.searchParams.set("code", input.code ?? "auth-code-1");
  url.searchParams.set("state", input.state);

  const request = new NextRequest(url, {
    headers: input.cookie
      ? { cookie: `${OAUTH_STATE_COOKIE}=${input.cookie}` }
      : {},
  });
  return callbackRoute.GET(request, {
    params: Promise.resolve({ provider: input.slug }),
  });
}

/** Runs connect → callback and returns the redirect the user lands on. */
async function connectProvider(slug: string): Promise<RouteResponse> {
  const started = await startConnect(slug);
  const cookie = started.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const state = new URL(started.headers.get("location") ?? "").searchParams.get(
    "state",
  );
  return completeCallback({ slug, state: state ?? "", cookie });
}

function row(provider: string): FakeRow {
  const found = db.rows.find(
    (candidate) => candidate.provider === provider,
  ) as FakeRow | undefined;
  if (!found) throw new Error(`no ${provider} row was written`);
  return found;
}

beforeEach(() => {
  db.rows = [];
  db.nextId = 1;
  session.userId = USER_ID;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connect", () => {
  it("sends the user to the provider with a state cookie bound to that provider", async () => {
    const response = await startConnect("jira");
    const location = new URL(response.headers.get("location") ?? "");
    const state = location.searchParams.get("state");

    expect(location.origin + location.pathname).toBe(
      "https://auth.atlassian.com/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("jira-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://app.example.test/api/integrations/jira/callback",
    );
    expect(location.searchParams.get("scope")).toContain("offline_access");

    const cookie = response.cookies.get(OAUTH_STATE_COOKIE);
    expect(cookie?.value).toBe(`JIRA:${state}`);
    expect(cookie?.httpOnly).toBe(true);
  });

  it("refuses to start a flow for a provider the app is not registered with", async () => {
    const response = await startConnect("notion");
    const location = new URL(response.headers.get("location") ?? "");

    expect(location.pathname).toBe("/dashboard/integrations");
    expect(location.searchParams.get("error")).toBe("not_configured");
    expect(response.cookies.get(OAUTH_STATE_COOKIE)).toBeUndefined();
  });

  it("sends an unknown provider back to the page rather than failing", async () => {
    const response = await startConnect("slack");
    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("unknown_provider");
  });

  it("sends a signed-out visitor to sign-in instead of a provider", async () => {
    session.userId = null;
    const response = await startConnect("jira");
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/sign-in",
    );
  });
});

describe("callback", () => {
  it("stores encrypted tokens with the account and workspace label", async () => {
    mockFetch(JIRA_HANDLERS);

    const response = await connectProvider("jira");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("connected")).toBe("Jira");

    const stored = row("JIRA");
    expect(stored.status).toBe("CONNECTED");
    expect(stored.accountLabel).toBe("Acme Jira");
    expect(stored.workspaceRef).toBe("cloud-id-123");
    expect(stored.expiresAt).toBeInstanceOf(Date);
    expect(decryptToken(stored.accessTokenEnc ?? "")).toBe(JIRA_ACCESS);
    expect(decryptToken(stored.refreshTokenEnc ?? "")).toBe(JIRA_REFRESH);
  });

  it("writes no plaintext token anywhere in the persisted row", async () => {
    mockFetch(JIRA_HANDLERS);
    await connectProvider("jira");

    const serialized = JSON.stringify(row("JIRA"));
    expect(serialized).not.toContain(JIRA_ACCESS);
    expect(serialized).not.toContain(JIRA_REFRESH);
  });

  it("reconnecting replaces the tokens on the existing row", async () => {
    mockFetch(JIRA_HANDLERS);
    await connectProvider("jira");
    const firstId = row("JIRA").id;
    const firstCiphertext = row("JIRA").accessTokenEnc;

    mockFetch({
      ...JIRA_HANDLERS,
      "https://auth.atlassian.com/oauth/token": () =>
        jsonResponse({
          access_token: "jira-access-token-second",
          refresh_token: JIRA_REFRESH,
          expires_in: 3600,
        }),
    });
    await connectProvider("jira");

    expect(db.rows).toHaveLength(1);
    expect(row("JIRA").id).toBe(firstId);
    expect(row("JIRA").accessTokenEnc).not.toBe(firstCiphertext);
    expect(decryptToken(row("JIRA").accessTokenEnc ?? "")).toBe(
      "jira-access-token-second",
    );
  });

  it("connects Linear without a refresh token", async () => {
    mockFetch({
      "https://api.linear.app/oauth/token": () =>
        jsonResponse({ access_token: LINEAR_ACCESS, scope: ["read", "write"] }),
      "https://api.linear.app/graphql": () =>
        jsonResponse({
          data: {
            viewer: { email: "jane@acme.test", name: "Jane" },
            organization: { id: "org-9", name: "Acme" },
          },
        }),
    });

    await connectProvider("linear");

    const stored = row("LINEAR");
    expect(stored.status).toBe("CONNECTED");
    expect(stored.accountLabel).toBe("jane@acme.test");
    expect(stored.workspaceRef).toBe("org-9");
    expect(stored.refreshTokenEnc).toBeNull();
    expect(stored.scope).toBe("read write");
  });

  it("spends no code when the state does not match the cookie", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await completeCallback({
      slug: "jira",
      state: "attacker-supplied-state",
      cookie: "JIRA:the-real-state",
    });

    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("invalid_state");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(0);
  });

  it("rejects a state minted for a different provider", async () => {
    const started = await startConnect("jira");
    const jiraCookie = started.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "";
    const state = jiraCookie.split(":")[1];
    vi.stubGlobal("fetch", vi.fn());

    const response = await completeCallback({
      slug: "linear",
      state,
      cookie: jiraCookie,
    });

    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("invalid_state");
    expect(db.rows).toHaveLength(0);
  });

  it("reports a denied consent without writing a row", async () => {
    const started = await startConnect("jira");
    const cookie = started.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "";

    const response = await completeCallback({
      slug: "jira",
      state: cookie.split(":")[1],
      cookie,
      error: "access_denied",
    });

    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("denied");
    expect(db.rows).toHaveLength(0);
  });

  it("surfaces a failed exchange instead of storing a broken connection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({
      "https://auth.atlassian.com/oauth/token": () =>
        jsonResponse({ error: "invalid_grant" }, 400),
    });

    const response = await connectProvider("jira");

    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("exchange_failed");
    expect(db.rows).toHaveLength(0);
  });
});

describe("disconnect", () => {
  it("clears every trace of the grant but keeps the row", async () => {
    mockFetch(JIRA_HANDLERS);
    await connectProvider("jira");

    const form = new FormData();
    form.set("provider", "jira");
    await disconnectProviderAction(form);

    const stored = row("JIRA");
    expect(stored.status).toBe("DISCONNECTED");
    expect(stored.accessTokenEnc).toBeNull();
    expect(stored.refreshTokenEnc).toBeNull();
    expect(stored.accountLabel).toBeNull();
    expect(stored.workspaceRef).toBeNull();
  });

  it("touches nothing when the form names a provider that does not exist", async () => {
    mockFetch(JIRA_HANDLERS);
    await connectProvider("jira");

    const form = new FormData();
    form.set("provider", "slack");
    await expect(disconnectProviderAction(form)).rejects.toThrow(
      /Unknown provider/,
    );
    expect(row("JIRA").status).toBe("CONNECTED");
  });
});

describe("token refresh", () => {
  async function connectedJira() {
    mockFetch(JIRA_HANDLERS);
    await connectProvider("jira");
    const integration = await findIntegration(USER_ID, "JIRA");
    if (!integration) throw new Error("expected a connected Jira integration");
    return integration;
  }

  it("refreshes once on a 401 and retries the call", async () => {
    const integration = await connectedJira();

    const seenTokens: string[] = [];
    mockFetch({
      "https://auth.atlassian.com/oauth/token": () =>
        jsonResponse({
          access_token: "jira-access-token-refreshed",
          refresh_token: "jira-refresh-token-rotated",
          expires_in: 3600,
        }),
      "https://api.atlassian.com/ex/jira": () =>
        jsonResponse(
          {},
          seenTokens[seenTokens.length - 1] === "jira-access-token-refreshed"
            ? 200
            : 401,
        ),
    });

    const response = await withFreshToken(integration, async (accessToken) => {
      seenTokens.push(accessToken);
      return fetch("https://api.atlassian.com/ex/jira/issue");
    });

    expect(response.status).toBe(200);
    expect(seenTokens).toEqual([JIRA_ACCESS, "jira-access-token-refreshed"]);

    const stored = row("JIRA");
    expect(stored.status).toBe("CONNECTED");
    expect(decryptToken(stored.accessTokenEnc ?? "")).toBe(
      "jira-access-token-refreshed",
    );
    expect(decryptToken(stored.refreshTokenEnc ?? "")).toBe(
      "jira-refresh-token-rotated",
    );
  });

  it("flips the integration to EXPIRED when the refresh itself fails", async () => {
    const integration = await connectedJira();

    mockFetch({
      "https://auth.atlassian.com/oauth/token": () =>
        jsonResponse({ error: "invalid_grant" }, 400),
      "https://api.atlassian.com/ex/jira": () => jsonResponse({}, 401),
    });

    await expect(
      withFreshToken(integration, async (accessToken) =>
        fetch("https://api.atlassian.com/ex/jira/issue", {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
      ),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError);

    const stored = row("JIRA");
    expect(stored.status).toBe("EXPIRED");
    expect(stored.accessTokenEnc).toBeNull();
    expect(stored.refreshTokenEnc).toBeNull();
  });

  it("retries only once — a refreshed token that is still rejected expires", async () => {
    const integration = await connectedJira();

    let refreshes = 0;
    mockFetch({
      "https://auth.atlassian.com/oauth/token": () => {
        refreshes += 1;
        return jsonResponse({
          access_token: `jira-access-token-${refreshes}`,
          refresh_token: JIRA_REFRESH,
          expires_in: 3600,
        });
      },
      "https://api.atlassian.com/ex/jira": () => jsonResponse({}, 401),
    });

    await expect(
      withFreshToken(integration, async () =>
        fetch("https://api.atlassian.com/ex/jira/issue"),
      ),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError);

    expect(refreshes).toBe(1);
    expect(row("JIRA").status).toBe("EXPIRED");
  });

  it("expires a provider that cannot refresh at all, without calling a token endpoint", async () => {
    mockFetch({
      "https://api.linear.app/oauth/token": () =>
        jsonResponse({ access_token: LINEAR_ACCESS }),
      "https://api.linear.app/graphql": () =>
        jsonResponse({
          data: { viewer: { email: "jane@acme.test" }, organization: { id: "org-9" } },
        }),
    });
    await connectProvider("linear");
    const integration = await findIntegration(USER_ID, "LINEAR");
    if (!integration) throw new Error("expected a connected Linear integration");

    mockFetch({
      "https://api.linear.app/graphql": () => jsonResponse({}, 401),
    });

    await expect(
      withFreshToken(integration, async () =>
        fetch("https://api.linear.app/graphql", { method: "POST" }),
      ),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError);

    expect(row("LINEAR").status).toBe("EXPIRED");
  });

  it("hands a non-401 provider error back to the caller untouched", async () => {
    const integration = await connectedJira();
    mockFetch({
      "https://api.atlassian.com/ex/jira": () =>
        jsonResponse({ errorMessages: ["No such project"] }, 404),
    });

    const response = await withFreshToken(integration, async () =>
      fetch("https://api.atlassian.com/ex/jira/issue"),
    );

    expect(response.status).toBe(404);
    expect(row("JIRA").status).toBe("CONNECTED");
  });

  it("refuses to use a disconnected integration", async () => {
    await connectedJira();
    const form = new FormData();
    form.set("provider", "jira");
    await disconnectProviderAction(form);

    const stale = await findIntegration(USER_ID, "JIRA");
    if (!stale) throw new Error("expected the row to survive a disconnect");

    await expect(
      withFreshToken(stale, async () => jsonResponse({})),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError);
  });
});
