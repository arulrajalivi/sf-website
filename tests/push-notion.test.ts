import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationRow } from "@/lib/integrations/store";
import type { PushContext, PushStoryInput } from "@/lib/push/types";

import { resetFakePrisma, seedIntegration } from "./support/fake-prisma";
import type { RecordedApi, RecordedRoute } from "./support/recorded-api";
import { installRecordedApi, loadFixture } from "./support/recorded-api";

/**
 * The Notion module against recorded responses.
 *
 * Notion is the odd one out: there is no issue type, so a story is a page and a
 * task is a to-do block appended to it. What the tests hold in place is the
 * version header Notion requires on every call, the page-under-page parent that
 * the connect grant actually allows, and the anchor link that makes a task's
 * "open in Notion" land on its own block rather than the top of the page.
 */

process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

vi.mock("@/lib/prisma", async () => {
  const { fakePrisma } = await import("./support/fake-prisma");
  return { prisma: fakePrisma };
});

const { notionTarget } = await import("@/lib/push/targets/notion");
const { findIntegration } = await import("@/lib/integrations/store");
const { encryptToken } = await import("@/lib/crypto");

const USER_ID = "user_1";
const PARENT_PAGE_ID = "1a2b3c4d-0000-4000-8000-000000000001";
const STORY_PAGE_ID = "9f8e7d6c-0000-4000-8000-000000000002";
const BLOCK_ID = "5c4b3a29-0000-4000-8000-000000000003";

const STORY: PushStoryInput = {
  id: "story_1",
  title: "Request a reset link",
  description: "As a user I want to request a reset link so that I can sign in again.",
  acceptanceCriteria: ["An email arrives within a minute"],
  tasks: [{ id: "task_1", title: "Add reset endpoint", description: "POST /auth/reset" }],
};

function notionRoutes(overrides: Partial<Record<string, RecordedRoute>> = {}): RecordedRoute[] {
  return [
    overrides.me ?? {
      url: "/v1/users/me",
      reply: { body: loadFixture("notion/me.json") },
    },
    overrides.search ?? {
      url: "/v1/search",
      method: "POST",
      reply: { body: loadFixture("notion/search-pages.json") },
    },
    overrides.pages ?? {
      url: "/v1/pages",
      method: "POST",
      reply: { body: loadFixture("notion/page-created.json") },
    },
    overrides.blocks ?? {
      url: "/v1/blocks/",
      method: "PATCH",
      reply: { body: loadFixture("notion/blocks-appended.json") },
    },
  ];
}

async function connectedIntegration(): Promise<IntegrationRow> {
  seedIntegration({
    id: "int_notion",
    userId: USER_ID,
    provider: "NOTION",
    workspaceRef: "notion-workspace-1",
    accessTokenEnc: encryptToken("notion-access-current"),
    refreshTokenEnc: null,
  });
  const row = await findIntegration(USER_ID, "NOTION");
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

describe("notionTarget", () => {
  it("creates the story as a page under a shared page", async () => {
    api = installRecordedApi(notionRoutes());
    const integration = await connectedIntegration();

    const story = await notionTarget.pushStory(STORY, contextFor(integration));

    expect(story).toEqual({
      externalId: STORY_PAGE_ID,
      externalUrl:
        "https://www.notion.so/Request-a-reset-link-9f8e7d6c000040008000000000000002",
    });

    const create = api.callsTo("/v1/pages")[0];
    const body = create.body as {
      parent: { page_id: string };
      properties: { title: { title: { text: { content: string } }[] } };
      children: { type: string }[];
    };
    expect(body.parent).toEqual({ page_id: PARENT_PAGE_ID });
    expect(body.properties.title.title[0].text.content).toBe("Request a reset link");

    const serialized = JSON.stringify(body.children);
    expect(serialized).toContain("An email arrives within a minute");
    expect(serialized).toContain("From requirement: Password reset");
  });

  it("appends each task as an unchecked to-do linking to its own block", async () => {
    api = installRecordedApi(notionRoutes());
    const integration = await connectedIntegration();
    const ctx = contextFor(integration);

    const story = await notionTarget.pushStory(STORY, ctx);
    const task = await notionTarget.pushTask(STORY.tasks[0], story, ctx);

    const append = api.callsTo("/v1/blocks/")[0];
    expect(append.url).toContain(STORY_PAGE_ID);
    const child = (append.body as { children: Record<string, unknown>[] }).children[0] as {
      type: string;
      to_do: { checked: boolean; rich_text: { text: { content: string } }[] };
    };
    expect(child.type).toBe("to_do");
    expect(child.to_do.checked).toBe(false);
    expect(child.to_do.rich_text[0].text.content).toContain("Add reset endpoint");

    expect(task.externalId).toBe(BLOCK_ID);
    // The anchor is the block id with dashes stripped, which is the form Notion
    // uses in its own URLs.
    expect(task.externalUrl).toBe(
      "https://www.notion.so/Request-a-reset-link-9f8e7d6c000040008000000000000002#5c4b3a29000040008000000000000003",
    );
  });

  it("sends the pinned API version on every request", async () => {
    api = installRecordedApi(notionRoutes());
    const integration = await connectedIntegration();
    const ctx = contextFor(integration);

    const story = await notionTarget.pushStory(STORY, ctx);
    await notionTarget.pushTask(STORY.tasks[0], story, ctx);
    await notionTarget.ensureFresh(integration);

    expect(api.calls).not.toHaveLength(0);
    for (const call of api.calls) {
      expect(call.headers["notion-version"]).toBe("2022-06-28");
    }
  });

  it("looks up the parent page once per run", async () => {
    api = installRecordedApi(notionRoutes());
    const integration = await connectedIntegration();
    const ctx = contextFor(integration);

    await notionTarget.pushStory(STORY, ctx);
    await notionTarget.pushStory({ ...STORY, id: "story_2" }, ctx);

    expect(api.callsTo("/v1/search")).toHaveLength(1);
  });

  it("tells the user to share a page when nothing is shared with the connection", async () => {
    api = installRecordedApi(
      notionRoutes({
        search: {
          url: "/v1/search",
          method: "POST",
          reply: { body: loadFixture("notion/search-empty.json") },
        },
      }),
    );
    const integration = await connectedIntegration();

    await expect(
      notionTarget.pushStory(STORY, contextFor(integration)),
    ).rejects.toThrow(/share a page with the integration/i);
    expect(api.callsTo("/v1/pages")).toHaveLength(0);
  });

  it("checks the connection before creating anything", async () => {
    api = installRecordedApi(notionRoutes());
    const integration = await connectedIntegration();

    await notionTarget.ensureFresh(integration);

    const probes = api.callsTo("/v1/users/me");
    expect(probes).toHaveLength(1);
    expect(probes[0].headers.authorization).toBe("Bearer notion-access-current");
  });
});
