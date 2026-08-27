import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Provider } from "@/generated/prisma/enums";
import type {
  PushResult,
  PushStoryInput,
  PushTarget,
  PushTaskInput,
} from "@/lib/push/types";

import {
  fakeDb,
  resetFakePrisma,
  seedIntegration,
  seedRequirement,
  seedStory,
} from "./support/fake-prisma";

/**
 * Push orchestration, with the providers replaced by stubs.
 *
 * The behaviour under test is the spec's partial-push guarantee, which is a
 * property of *this* module and not of any provider: one tool failing must not
 * cost the user the tools that work, and every attempt — succeeded or failed —
 * must leave a row behind. Stub targets are the honest fixture here; the real
 * Jira/Linear/Notion request shapes are asserted in their own suites.
 */

vi.mock("@/lib/prisma", async () => {
  const { fakePrisma } = await import("./support/fake-prisma");
  return { prisma: fakePrisma };
});

const {
  pushRequirement,
  NoTargetsSelectedError,
  NothingToPushError,
  PushRequirementNotFoundError,
} = await import("@/lib/push/service");
const { listPushHistory } = await import("@/lib/push/store");

const USER_ID = "user_1";
const OTHER_USER_ID = "user_2";
const REQUIREMENT_ID = "req_1";

/** A target that records what it was asked to do and answers as told. */
function stubTarget(
  provider: Provider,
  behaviour: {
    ensureFresh?: () => Promise<void>;
    story?: (story: PushStoryInput) => Promise<PushResult>;
    task?: (task: PushTaskInput, parent: PushResult) => Promise<PushResult>;
  } = {},
): PushTarget {
  return {
    provider,
    ensureFresh: behaviour.ensureFresh ?? (async () => {}),
    pushStory:
      behaviour.story ??
      (async (story) => ({
        externalId: `${provider}-${story.id}`,
        externalUrl: `https://${provider.toLowerCase()}.test/${story.id}`,
      })),
    pushTask:
      behaviour.task ??
      (async (task) => ({
        externalId: `${provider}-${task.id}`,
        externalUrl: `https://${provider.toLowerCase()}.test/${task.id}`,
      })),
  };
}

function registry(
  overrides: Partial<Record<Provider, PushTarget>> = {},
): Record<Provider, PushTarget> {
  return {
    JIRA: overrides.JIRA ?? stubTarget("JIRA"),
    LINEAR: overrides.LINEAR ?? stubTarget("LINEAR"),
    NOTION: overrides.NOTION ?? stubTarget("NOTION"),
  };
}

function seedDraft(): void {
  seedRequirement({
    id: REQUIREMENT_ID,
    userId: USER_ID,
    rawText: "Users must be able to reset their password.",
    title: "Password reset",
  });
  seedStory({
    id: "story_1",
    requirementId: REQUIREMENT_ID,
    title: "Request a reset link",
    tasks: [
      { id: "task_1", title: "Add reset endpoint" },
      { id: "task_2", title: "Send reset email" },
    ],
  });
}

beforeEach(() => {
  resetFakePrisma();
  seedDraft();
  seedIntegration({ id: "int_jira", userId: USER_ID, provider: "JIRA" });
  seedIntegration({ id: "int_linear", userId: USER_ID, provider: "LINEAR" });
});

describe("pushRequirement", () => {
  it("records every story and task it created, with a link each", async () => {
    const result = await pushRequirement({
      userId: USER_ID,
      requirementId: REQUIREMENT_ID,
      providers: ["JIRA"],
      targets: registry(),
    });

    expect(result.created).toBe(3);
    expect(result.failed).toBe(0);

    const history = await listPushHistory(USER_ID);
    expect(history).toHaveLength(3);
    expect(history.every((entry) => entry.status === "CREATED")).toBe(true);
    expect(history.every((entry) => entry.externalUrl !== null)).toBe(true);
    expect(history.filter((entry) => entry.kind === "task")).toHaveLength(2);
    expect(history.map((entry) => entry.requirementTitle)).toEqual([
      "Password reset",
      "Password reset",
      "Password reset",
    ]);
  });

  it("lets one provider fail without blocking the others, and shows both in history", async () => {
    const result = await pushRequirement({
      userId: USER_ID,
      requirementId: REQUIREMENT_ID,
      providers: ["JIRA", "LINEAR"],
      targets: registry({
        JIRA: stubTarget("JIRA", {
          story: async () => {
            throw new Error("JIRA create issue failed with HTTP 500.");
          },
        }),
      }),
    });

    const jira = result.outcomes.find((outcome) => outcome.provider === "JIRA");
    const linear = result.outcomes.find(
      (outcome) => outcome.provider === "LINEAR",
    );
    expect(jira?.created).toBe(0);
    expect(jira?.failed).toBe(3);
    expect(linear?.created).toBe(3);
    expect(linear?.failed).toBe(0);

    const history = await listPushHistory(USER_ID);
    expect(history).toHaveLength(6);

    const jiraRows = history.filter((entry) => entry.provider === "JIRA");
    expect(jiraRows.every((entry) => entry.status === "FAILED")).toBe(true);
    expect(jiraRows.every((entry) => entry.externalUrl === null)).toBe(true);
    expect(
      jiraRows.some((entry) => entry.error?.includes("HTTP 500")),
    ).toBe(true);

    const linearRows = history.filter((entry) => entry.provider === "LINEAR");
    expect(linearRows.every((entry) => entry.status === "CREATED")).toBe(true);
    expect(linearRows.every((entry) => entry.externalUrl !== null)).toBe(true);
  });

  it("keeps a failed task from costing its siblings or its story", async () => {
    const result = await pushRequirement({
      userId: USER_ID,
      requirementId: REQUIREMENT_ID,
      providers: ["LINEAR"],
      targets: registry({
        LINEAR: stubTarget("LINEAR", {
          task: async (task) => {
            if (task.id === "task_1") {
              throw new Error("LINEAR issueCreate failed with HTTP 422.");
            }
            return {
              externalId: `LINEAR-${task.id}`,
              externalUrl: `https://linear.test/${task.id}`,
            };
          },
        }),
      }),
    });

    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);

    const history = await listPushHistory(USER_ID);
    const failed = history.filter((entry) => entry.status === "FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].itemTitle).toBe("Add reset endpoint");
    expect(failed[0].error).toContain("HTTP 422");
  });

  it("records a story's tasks as failed when the story itself never lands", async () => {
    await pushRequirement({
      userId: USER_ID,
      requirementId: REQUIREMENT_ID,
      providers: ["JIRA"],
      targets: registry({
        JIRA: stubTarget("JIRA", {
          story: async () => {
            throw new Error("JIRA create issue failed with HTTP 403.");
          },
        }),
      }),
    });

    const history = await listPushHistory(USER_ID);
    const tasks = history.filter((entry) => entry.kind === "task");
    expect(tasks).toHaveLength(2);
    expect(
      tasks.every((entry) => entry.error?.startsWith("Its story could not be")),
    ).toBe(true);
  });

  it("fails every item of an expired connection, and still pushes the healthy one", async () => {
    const result = await pushRequirement({
      userId: USER_ID,
      requirementId: REQUIREMENT_ID,
      providers: ["JIRA", "LINEAR"],
      targets: registry({
        JIRA: stubTarget("JIRA", {
          ensureFresh: async () => {
            throw new Error("JIRA rejected the stored token — reconnect it.");
          },
        }),
      }),
    });

    expect(result.outcomes[0].error).toContain("reconnect");
    expect(result.outcomes[0].failed).toBe(3);
    expect(result.outcomes[1].created).toBe(3);

    const history = await listPushHistory(USER_ID);
    expect(history.filter((entry) => entry.provider === "JIRA")).toHaveLength(3);
  });

  it("reports a provider the user never connected without inventing history", async () => {
    const result = await pushRequirement({
      userId: USER_ID,
      requirementId: REQUIREMENT_ID,
      providers: ["NOTION"],
      targets: registry(),
    });

    expect(result.outcomes[0].error).toContain("not connected");
    expect(fakeDb.pushRecords).toHaveLength(0);
  });

  it("refuses a push with no destination, no stories, or another user's draft", async () => {
    await expect(
      pushRequirement({
        userId: USER_ID,
        requirementId: REQUIREMENT_ID,
        providers: [],
        targets: registry(),
      }),
    ).rejects.toBeInstanceOf(NoTargetsSelectedError);

    seedRequirement({
      id: "req_empty",
      userId: USER_ID,
      rawText: "Nothing generated yet.",
    });
    await expect(
      pushRequirement({
        userId: USER_ID,
        requirementId: "req_empty",
        providers: ["JIRA"],
        targets: registry(),
      }),
    ).rejects.toBeInstanceOf(NothingToPushError);

    await expect(
      pushRequirement({
        userId: OTHER_USER_ID,
        requirementId: REQUIREMENT_ID,
        providers: ["JIRA"],
        targets: registry(),
      }),
    ).rejects.toBeInstanceOf(PushRequirementNotFoundError);

    expect(fakeDb.pushRecords).toHaveLength(0);
  });
});
