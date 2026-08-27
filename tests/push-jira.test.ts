import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationRow } from "@/lib/integrations/store";
import type { PushContext, PushStoryInput } from "@/lib/push/types";

import { resetFakePrisma, seedIntegration } from "./support/fake-prisma";
import type { RecordedApi, RecordedRoute } from "./support/recorded-api";
import { installRecordedApi, loadFixture } from "./support/recorded-api";

/**
 * The Jira module against recorded Atlassian responses.
 *
 * What is asserted here is the half we control and get wrong: the cloudId host,
 * the ADF description v3 requires, the subtask type and `parent` key that make a
 * subtask a subtask rather than a loose issue, and the browse URL — which cannot
 * come from `self`, because `self` points at the API. Plus the 401 path, since
 * "the token expired mid-push" is a spec state and not a hypothetical.
 */

process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.INTEGRATION_JIRA_CLIENT_ID = "jira-client";
process.env.INTEGRATION_JIRA_CLIENT_SECRET = "jira-secret";

vi.mock("@/lib/prisma", async () => {
  const { fakePrisma } = await import("./support/fake-prisma");
  return { prisma: fakePrisma };
});

const { jiraTarget } = await import("@/lib/push/targets/jira");
const { PushTargetError } = await import("@/lib/push/types");
const { findIntegration } = await import("@/lib/integrations/store");
const { encryptToken, decryptToken } = await import("@/lib/crypto");

const USER_ID = "user_1";
const CLOUD_ID = "cloud-1";

const STORY: PushStoryInput = {
  id: "story_1",
  title: "Request a reset link",
  description: "As a user I want to request a reset link so that I can sign in again.",
  acceptanceCriteria: ["An email arrives within a minute", "The link expires in an hour"],
  tasks: [{ id: "task_1", title: "Add reset endpoint", description: "POST /auth/reset" }],
};

/** The happy-path recording: every endpoint one push run touches. */
function jiraRoutes(overrides: Partial<Record<string, RecordedRoute>> = {}): RecordedRoute[] {
  return [
    overrides.myself ?? { url: "/rest/api/3/myself", reply: { body: loadFixture("jira/myself.json") } },
    overrides.project ?? {
      url: "/rest/api/3/project/search",
      reply: { body: loadFixture("jira/project-search.json") },
    },
    overrides.serverInfo ?? {
      url: "/rest/api/3/serverInfo",
      reply: { body: loadFixture("jira/server-info.json") },
    },
    overrides.issue ?? {
      url: "/rest/api/3/issue",
      method: "POST",
      replies: [
        { body: loadFixture("jira/issue-created.json") },
        { body: loadFixture("jira/subtask-created.json") },
      ],
    },
    overrides.token ?? {
      url: "https://auth.atlassian.com/oauth/token",
      method: "POST",
      reply: { body: loadFixture("jira/token-refresh.json") },
    },
  ];
}

async function connectedIntegration(
  overrides: { workspaceRef?: string | null } = {},
): Promise<IntegrationRow> {
  seedIntegration({
    id: "int_jira",
    userId: USER_ID,
    provider: "JIRA",
    workspaceRef: overrides.workspaceRef === undefined ? CLOUD_ID : overrides.workspaceRef,
    accessTokenEnc: encryptToken("jira-access-current"),
    refreshTokenEnc: encryptToken("jira-refresh-current"),
  });
  const row = await findIntegration(USER_ID, "JIRA");
  if (!row) throw new Error("seeded integration missing");
  return row;
}

function contextFor(integration: IntegrationRow): PushContext {
  return {
    userId: USER_ID,
    integration,
    requirement: { id: "req_1", title: "Password reset" },
    cache: new Map(),
  };
}

let api: RecordedApi;

beforeEach(() => {
  resetFakePrisma();
});

afterEach(() => {
  api?.restore();
});

describe("jiraTarget", () => {
  it("creates the story as an issue and each task as a subtask of it", async () => {
    api = installRecordedApi(jiraRoutes());
    const integration = await connectedIntegration();
    const ctx = contextFor(integration);

    const story = await jiraTarget.pushStory(STORY, ctx);
    const task = await jiraTarget.pushTask(STORY.tasks[0], story, ctx);

    expect(story).toEqual({
      externalId: "SF-14",
      externalUrl: "https://acme.atlassian.net/browse/SF-14",
    });
    expect(task.externalUrl).toBe("https://acme.atlassian.net/browse/SF-15");

    const creates = api.callsTo("/rest/api/3/issue");
    expect(creates).toHaveLength(2);

    const storyFields = (creates[0].body as { fields: Record<string, unknown> }).fields;
    expect(storyFields.project).toEqual({ id: "10000" });
    expect(storyFields.issuetype).toEqual({ id: "10001" });
    expect(storyFields.summary).toBe("Request a reset link");
    expect(storyFields.parent).toBeUndefined();

    const subtaskFields = (creates[1].body as { fields: Record<string, unknown> }).fields;
    expect(subtaskFields.issuetype).toEqual({ id: "10003" });
    expect(subtaskFields.parent).toEqual({ key: "SF-14" });
  });

  it("sends the description as an ADF document, criteria included", async () => {
    api = installRecordedApi(jiraRoutes());
    const integration = await connectedIntegration();

    await jiraTarget.pushStory(STORY, contextFor(integration));

    const body = api.callsTo("/rest/api/3/issue")[0].body as {
      fields: { description: { type: string; version: number; content: unknown[] } };
    };
    expect(body.fields.description.type).toBe("doc");
    expect(body.fields.description.version).toBe(1);

    const serialized = JSON.stringify(body.fields.description);
    expect(serialized).toContain("An email arrives within a minute");
    expect(serialized).toContain("bulletList");
    expect(serialized).toContain("From requirement: Password reset");
  });

  it("looks up the project and site once per run, however many items it pushes", async () => {
    api = installRecordedApi(jiraRoutes());
    const integration = await connectedIntegration();
    const ctx = contextFor(integration);

    const story = await jiraTarget.pushStory(STORY, ctx);
    await jiraTarget.pushTask(STORY.tasks[0], story, ctx);

    expect(api.callsTo("/project/search")).toHaveLength(1);
    expect(api.callsTo("/serverInfo")).toHaveLength(1);
  });

  it("refreshes the token on a 401 and retries the create once", async () => {
    api = installRecordedApi(
      jiraRoutes({
        issue: {
          url: "/rest/api/3/issue",
          method: "POST",
          replies: [
            { status: 401, body: loadFixture("jira/unauthorized.json") },
            { body: loadFixture("jira/issue-created.json") },
          ],
        },
      }),
    );
    const integration = await connectedIntegration();

    const result = await jiraTarget.pushStory(STORY, contextFor(integration));

    expect(result.externalId).toBe("SF-14");
    expect(api.callsTo("https://auth.atlassian.com/oauth/token")).toHaveLength(1);
    expect(api.callsTo("/rest/api/3/issue")).toHaveLength(2);

    // The retry carries the *new* token, and the new token is what got stored.
    const retry = api.callsTo("/rest/api/3/issue")[1];
    expect(retry.headers.authorization).toBe("Bearer jira-access-refreshed");

    const stored = await findIntegration(USER_ID, "JIRA");
    expect(decryptToken(stored?.accessTokenEnc ?? "")).toBe("jira-access-refreshed");
  });

  it("checks the connection before creating anything", async () => {
    api = installRecordedApi(jiraRoutes());
    const integration = await connectedIntegration();

    await jiraTarget.ensureFresh(integration);

    const probes = api.callsTo("/rest/api/3/myself");
    expect(probes).toHaveLength(1);
    expect(probes[0].headers.authorization).toBe("Bearer jira-access-current");
  });

  it("names the fix when the connection has no Jira site on file", async () => {
    api = installRecordedApi(jiraRoutes());
    const integration = await connectedIntegration({ workspaceRef: null });

    await expect(
      jiraTarget.pushStory(STORY, contextFor(integration)),
    ).rejects.toBeInstanceOf(PushTargetError);
    await expect(
      jiraTarget.pushStory(STORY, contextFor(integration)),
    ).rejects.toThrow(/reconnect/i);
    expect(api.calls).toHaveLength(0);
  });

  it("names the fix when the project has subtasks disabled", async () => {
    api = installRecordedApi(
      jiraRoutes({
        project: {
          url: "/rest/api/3/project/search",
          reply: { body: loadFixture("jira/project-search-no-subtasks.json") },
        },
      }),
    );
    const integration = await connectedIntegration();

    await expect(
      jiraTarget.pushStory(STORY, contextFor(integration)),
    ).rejects.toThrow(/subtasks disabled/i);
    expect(api.callsTo("/rest/api/3/issue")).toHaveLength(0);
  });
});
