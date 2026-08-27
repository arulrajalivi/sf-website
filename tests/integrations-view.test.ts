import { describe, expect, it } from "vitest";

import {
  buildProviderCard,
  connectNotice,
} from "@/app/dashboard/integrations/connection-view";
import { providerDefinition } from "@/lib/integrations/providers";
import type { IntegrationRow } from "@/lib/integrations/store";

/**
 * What the Integrations page says about a connection, given a row.
 *
 * This is the half of the page a user reads to decide whether a push will work,
 * so each state gets an assertion: connected, never connected, expired, and the
 * provider this deployment has no credentials for.
 */

// The real definition, so a renamed env var breaks this test rather than the
// instructions a stuck operator reads on the page.
const JIRA = providerDefinition("JIRA");

const CONNECT_HREF = "/api/integrations/jira/connect";

function integration(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: "integration_1",
    userId: "user_1",
    provider: "JIRA",
    status: "CONNECTED",
    accountLabel: "Acme Jira",
    workspaceRef: "cloud-id-123",
    accessTokenEnc: "ciphertext",
    refreshTokenEnc: "ciphertext",
    expiresAt: null,
    scope: null,
    lastRefreshedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function card(
  input: Partial<Parameters<typeof buildProviderCard>[0]> = {},
) {
  return buildProviderCard({
    definition: JIRA,
    integration: null,
    isConfigured: true,
    connectHref: CONNECT_HREF,
    ...input,
  });
}

describe("provider card", () => {
  it("shows the account and workspace of a live connection", () => {
    const view = card({ integration: integration() });

    expect(view.status).toBe("Connected");
    expect(view.tone).toBe("connected");
    expect(view.account).toBe("Acme Jira · cloud-id-123");
    expect(view.canDisconnect).toBe(true);
    expect(view.connectLabel).toBe("Reconnect");
  });

  it("offers a plain Connect when nothing has ever been connected", () => {
    const view = card();

    expect(view.status).toBe("Not connected");
    expect(view.account).toBeNull();
    expect(view.canDisconnect).toBe(false);
    expect(view.connectHref).toBe(CONNECT_HREF);
    expect(view.note).toBeNull();
  });

  it("asks for a reconnect once the grant has expired, and shows no stale account", () => {
    const view = card({
      integration: integration({ status: "EXPIRED", accountLabel: "Acme Jira" }),
    });

    expect(view.status).toBe("Reconnect needed");
    expect(view.tone).toBe("attention");
    expect(view.account).toBeNull();
    expect(view.canDisconnect).toBe(false);
    expect(view.note).toContain("Reconnect");
  });

  it("treats a disconnected row exactly like a fresh one", () => {
    const view = card({
      integration: integration({
        status: "DISCONNECTED",
        accountLabel: null,
        workspaceRef: null,
      }),
    });

    expect(view.status).toBe("Not connected");
    expect(view.account).toBeNull();
  });

  it("names the missing env vars instead of offering a doomed Connect", () => {
    const view = card({ isConfigured: false });

    expect(view.status).toBe("Unavailable");
    expect(view.connectHref).toBeNull();
    expect(view.note).toContain("INTEGRATION_JIRA_CLIENT_ID");
    expect(view.note).toContain("INTEGRATION_JIRA_CLIENT_SECRET");
  });

  it("falls back to the workspace when the provider gave no account label", () => {
    const view = card({
      integration: integration({ accountLabel: null, workspaceRef: "org-9" }),
    });

    expect(view.account).toBe("org-9");
  });

  it("shows no account line when the provider gave neither", () => {
    const view = card({
      integration: integration({ accountLabel: null, workspaceRef: null }),
    });

    expect(view.account).toBeNull();
  });
});

describe("connect notice", () => {
  it("says nothing when the page was not reached from a connect attempt", () => {
    expect(
      connectNotice({ connected: null, error: null, provider: null }),
    ).toBeNull();
  });

  it("confirms a successful connection by name", () => {
    expect(
      connectNotice({ connected: "Jira", error: null, provider: null }),
    ).toEqual({ tone: "success", message: "Jira is connected." });
  });

  it("explains a denied consent", () => {
    const notice = connectNotice({
      connected: null,
      error: "denied",
      provider: "Linear",
    });

    expect(notice?.tone).toBe("error");
    expect(notice?.message).toContain("Linear");
    expect(notice?.message).toContain("Nothing was connected");
  });

  it("still says something true for an error code it does not recognise", () => {
    const notice = connectNotice({
      connected: null,
      error: "<script>alert(1)</script>",
      provider: null,
    });

    expect(notice?.tone).toBe("error");
    expect(notice?.message).toBe(
      "The connection attempt failed. Please try again.",
    );
  });
});
