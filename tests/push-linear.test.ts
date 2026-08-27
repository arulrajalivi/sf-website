import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationRow } from "@/lib/integrations/store";
import type { PushContext, PushStoryInput } from "@/lib/push/types";

import { resetFakePrisma, seedIntegration } from "./support/fake-prisma";
import type { RecordedApi, RecordedRoute } from "./support/recorded-api";
import { installRecordedApi, loadFixture } from "./support/recorded-api";

/**
 * The Linear module against recorded GraphQL responses.
 *
 * Linear's shape differs from Jira's in two ways worth pinning: a task is a
 * first-class issue joined to its story by a `blocks` relation rather than a
 * subtask, and a failure can arrive inside a 200 response as an `errors` array.
 * Both are asserted here, because both look like success to naive code.
 */

process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.INTEGRATION_LINEAR_CLIENT_ID = "linear-client";
process.env.INTEGRATION_LINEAR_CLIENT_SECRET = "linear-secret";

vi.mock("@/lib/prisma", async () => {
  const { fakePrisma } = await import("./support/fake-prisma");
  return { prisma: fakePrisma };
});

const { linearTarget } = await import("@/lib/push/targets/linear");
const { findIntegration } = await import("@/lib/integrations/store");
const { encryptToken } = await import("@/lib/crypto");

const USER_ID = "user_1";

const STORY: PushStoryInput = {
  id: "story_1",
  title: "Request a reset link",
  description: "As a user I want to request a reset link so that I can sign in again.",
  acceptanceCriteria: ["An email arrives within a minute"],
  tasks: [{ id: "task_1", title: "Add reset endpoint", description: "POST /auth/reset" }],
};

/**
 * Routes keyed by GraphQL operation name — one URL serves them all, so the
 * operation in the body is what distinguishes a team lookup from a create.
 */
function linearRoutes(overrides: Partial<Record<string, RecordedRoute>> = {}): RecordedRoute[] {
  return [
    overrides.viewer ?? {
      url: "api.linear.app/graphql",
      bodyIncludes: "PushViewer",
      reply: { body: loadFixture("linear/viewer.json") },
    },
    overrides.teams ?? {
      url: "api.linear.app/graphql",
      bodyIncludes: "PushTeams",
      reply: { body: loadFixture("linear/teams.json") },
    },
    overrides.relation ?? {
      url: "api.linear.app/graphql",
      bodyIncludes: "PushIssueRelation",
      reply: { body: loadFixture("linear/relation-created.json") },
    },
    overrides.issue ?? {
      url: "api.linear.app/graphql",
      bodyIncludes: "PushIssueCreate",
      replies: [
        { body: loadFixture("linear/issue-created.json") },
        { body: loadFixture("linear/task-issue-created.json") },
      ],
    },
  ];
}

async function connectedIntegration(): Promise<IntegrationRow> {
  seedIntegration({
    id: "int_linear",
    userId: USER_ID,
    provider: "LINEAR",
    workspaceRef: "acme",
    accessTokenEnc: encryptToken("linear-access-current"),
    refreshTokenEnc: encryptToken("linear-refresh-current"),
  });
  const row = await findIntegration(USER_ID, "LINEAR");
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

interface GraphQLRequest {
  query: string;
  variables: { input?: Record<string, unknown> };
}

function inputOf(call: { body: unknown }): Record<string, unknown> {
  return (call.body as GraphQLRequest).variables.input ?? {};
}

let api: RecordedApi;

beforeEach(() => {
  resetFakePrisma();
});

afterEach(() => {
  api?.restore();
});

describe("linearTarget", () => {
  it("creates the story in the workspace's team and returns its identifier", async () => {
    api = installRecordedApi(linearRoutes());
    const integration = await connectedIntegration();

    const story = await linearTarget.pushStory(STORY, contextFor(integration));

    expect(story).toEqual({
      externalId: "ENG-42",
      externalUrl: "https://linear.app/acme/issue/ENG-42/request-a-reset-link",
    });

    const input = inputOf(api.callsWith("PushIssueCreate")[0]);
    expect(input.teamId).toBe("team-uuid-1");
    expect(input.title).toBe("Request a reset link");
    expect(String(input.description)).toContain("An email arrives within a minute");
    expect(String(input.description)).toContain("From requirement: Password reset");
  });

  it("creates a task as its own issue that blocks the story", async () => {
    api = installRecordedApi(linearRoutes());
    const integration = await connectedIntegration();
    const ctx = contextFor(integration);

    const story = await linearTarget.pushStory(STORY, ctx);
    const task = await linearTarget.pushTask(STORY.tasks[0], story, ctx);

    expect(task.externalId).toBe("ENG-43");

    const relation = inputOf(api.callsWith("PushIssueRelation")[0]);
    // UUIDs, not identifiers: the relation mutation takes internal ids, and the
    // direction is task-blocks-story.
    expect(relation).toEqual({
      issueId: "issue-uuid-2",
      relatedIssueId: "issue-uuid-1",
      type: "blocks",
    });
  });

  it("looks the team up once per run", async () => {
    api = installRecordedApi(linearRoutes());
    const integration = await connectedIntegration();
    const ctx = contextFor(integration);

    const story = await linearTarget.pushStory(STORY, ctx);
    await linearTarget.pushTask(STORY.tasks[0], story, ctx);

    expect(api.callsWith("PushTeams")).toHaveLength(1);
  });

  it("treats an errors array in a 200 response as a failure", async () => {
    api = installRecordedApi(
      linearRoutes({
        issue: {
          url: "api.linear.app/graphql",
          bodyIncludes: "PushIssueCreate",
          reply: { body: loadFixture("linear/errors.json") },
        },
      }),
    );
    const integration = await connectedIntegration();

    await expect(
      linearTarget.pushStory(STORY, contextFor(integration)),
    ).rejects.toThrow(/Argument Validation Error/);
  });

  it("names the fix when no team is visible to the connection", async () => {
    api = installRecordedApi(
      linearRoutes({
        teams: {
          url: "api.linear.app/graphql",
          bodyIncludes: "PushTeams",
          reply: { body: loadFixture("linear/teams-empty.json") },
        },
      }),
    );
    const integration = await connectedIntegration();

    await expect(
      linearTarget.pushStory(STORY, contextFor(integration)),
    ).rejects.toThrow(/No Linear team/);
    expect(api.callsWith("PushIssueCreate")).toHaveLength(0);
  });

  it("refuses to link a task whose story was not pushed in this run", async () => {
    api = installRecordedApi(linearRoutes());
    const integration = await connectedIntegration();
    const ctx = contextFor(integration);

    await expect(
      linearTarget.pushTask(
        STORY.tasks[0],
        { externalId: "ENG-99", externalUrl: "https://linear.app/acme/issue/ENG-99" },
        ctx,
      ),
    ).rejects.toThrow(/ENG-99/);
  });

  it("checks the connection before creating anything", async () => {
    api = installRecordedApi(linearRoutes());
    const integration = await connectedIntegration();

    await linearTarget.ensureFresh(integration);

    const probes = api.callsWith("PushViewer");
    expect(probes).toHaveLength(1);
    expect(probes[0].headers.authorization).toBe("Bearer linear-access-current");
  });
});
