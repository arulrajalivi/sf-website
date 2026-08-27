import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeDb,
  resetFakePrisma,
  seedRequirement,
  seedStory,
} from "./support/fake-prisma";

/**
 * The draft editor and its server actions.
 *
 * The actions are the interesting half: they are public endpoints, so the tests
 * that matter are the ones where the caller asks for something that is not
 * theirs, or where a generation fails and the typing must survive.
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

const session = vi.hoisted(() => ({ userId: "user_1" }));

vi.mock("@/lib/prisma", async () => {
  const { fakePrisma } = await import("./support/fake-prisma");
  return { prisma: fakePrisma };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new RedirectError(path);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
}));

const {
  submitRequirementAction,
  saveStoryAction,
  saveTaskAction,
  generateDraftAction,
  IDLE_ACTION_STATE,
} = await import("@/app/dashboard/requirements/actions");
const { criteriaToText, textToCriteria, requirementInputSchema } = await import(
  "@/app/dashboard/requirements/draft-form"
);
const { PushPanel } = await import("@/app/dashboard/requirements/push-panel");
const { DraftEditor } = await import(
  "@/app/dashboard/requirements/[requirementId]/draft-editor"
);

const LONG_ENOUGH =
  "Users must be able to reset their password from the sign-in screen.";

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

beforeEach(() => {
  resetFakePrisma();
  session.userId = "user_1";
  // No key configured: the generation call fails at the client, which is the
  // path this file exercises. Generation success has its own test file.
  delete process.env.OPENAI_API_KEY;
});

describe("acceptance criteria round-trip", () => {
  it("edits as one line per criterion and stores a trimmed list", () => {
    const criteria = ["Given a, When b, Then c.", "Given d, Then e."];
    expect(textToCriteria(criteriaToText(criteria))).toEqual(criteria);
  });

  it("drops blank lines rather than storing empty criteria", () => {
    expect(textToCriteria("first\n\n   \nsecond\n")).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("requirement input validation", () => {
  it("rejects a requirement too short to generate from", () => {
    const result = requirementInputSchema.safeParse({ rawText: "do stuff" });
    expect(result.success).toBe(false);
  });

  it("accepts a real requirement and trims it", () => {
    const result = requirementInputSchema.safeParse({
      rawText: `  ${LONG_ENOUGH}  `,
    });
    expect(result.success && result.data.rawText).toBe(LONG_ENOUGH);
  });
});

describe("submitRequirementAction", () => {
  it("saves nothing when the requirement is too short, and echoes the text back", async () => {
    const state = await submitRequirementAction(
      IDLE_ACTION_STATE,
      formData({ rawText: "too short" }),
    );

    expect(state.status).toBe("error");
    expect(state.status === "error" && state.rawText).toBe("too short");
    expect(fakeDb.requirements).toHaveLength(0);
  });

  it("keeps the saved requirement when generation fails, and names the cause", async () => {
    const state = await submitRequirementAction(
      IDLE_ACTION_STATE,
      formData({ rawText: LONG_ENOUGH }),
    );

    // Missing OPENAI_API_KEY is a configuration failure, not a user error — the
    // message has to say which, and the user's text has to survive it.
    expect(state.status).toBe("error");
    expect(state.status === "error" && state.message).toMatch(/OPENAI_API_KEY/);
    expect(fakeDb.requirements).toHaveLength(1);
    expect(fakeDb.requirements[0].rawText).toBe(LONG_ENOUGH);
    expect(state.status === "error" && state.requirementId).toBe(
      fakeDb.requirements[0].id,
    );
    expect(state.status === "error" && state.rawText).toBe(LONG_ENOUGH);
  });
});

describe("generateDraftAction", () => {
  it("reports a missing requirement instead of throwing", async () => {
    const state = await generateDraftAction(IDLE_ACTION_STATE, formData({}));
    expect(state.status).toBe("error");
  });

  it("will not regenerate another user's requirement", async () => {
    seedRequirement({
      id: "req_other",
      userId: "user_2",
      rawText: LONG_ENOUGH,
    });

    const state = await generateDraftAction(
      IDLE_ACTION_STATE,
      formData({ requirementId: "req_other" }),
    );

    expect(state.status).toBe("error");
    expect(state.status === "error" && state.message).toContain(
      "no longer available",
    );
  });
});

describe("saveStoryAction", () => {
  beforeEach(() => {
    seedRequirement({ id: "req_1", userId: "user_1", rawText: LONG_ENOUGH });
    seedStory({
      id: "story_1",
      requirementId: "req_1",
      tasks: [{ id: "task_1", title: "Original task" }],
    });
  });

  it("saves an edited title, description, and criteria list", async () => {
    const state = await saveStoryAction(
      IDLE_ACTION_STATE,
      formData({
        storyId: "story_1",
        title: "  Edited title  ",
        description: "As a user, I want the edited thing.",
        acceptanceCriteria: "Given a, Then b.\n\nGiven c, Then d.",
      }),
    );

    expect(state.status).toBe("saved");
    expect(fakeDb.stories[0].title).toBe("Edited title");
    expect(fakeDb.stories[0].acceptanceCriteria).toEqual([
      "Given a, Then b.",
      "Given c, Then d.",
    ]);
  });

  it("refuses an empty title rather than saving a nameless story", async () => {
    const state = await saveStoryAction(
      IDLE_ACTION_STATE,
      formData({
        storyId: "story_1",
        title: "   ",
        description: "d",
        acceptanceCriteria: "",
      }),
    );

    expect(state.status).toBe("error");
    expect(fakeDb.stories[0].title).toBe("A story");
  });

  it("refuses to edit a story belonging to another user", async () => {
    session.userId = "user_2";

    const state = await saveStoryAction(
      IDLE_ACTION_STATE,
      formData({
        storyId: "story_1",
        title: "Hijacked",
        description: "d",
        acceptanceCriteria: "",
      }),
    );

    expect(state.status).toBe("error");
    expect(fakeDb.stories[0].title).toBe("A story");
  });

  it("saves a task edit and stores an emptied description as absent", async () => {
    const state = await saveTaskAction(
      IDLE_ACTION_STATE,
      formData({ taskId: "task_1", title: "Edited task", description: "  " }),
    );

    expect(state.status).toBe("saved");
    expect(fakeDb.tasks[0].title).toBe("Edited task");
    expect(fakeDb.tasks[0].description).toBeNull();
  });

  it("refuses to edit a task belonging to another user", async () => {
    session.userId = "user_2";

    const state = await saveTaskAction(
      IDLE_ACTION_STATE,
      formData({ taskId: "task_1", title: "Hijacked", description: "" }),
    );

    expect(state.status).toBe("error");
    expect(fakeDb.tasks[0].title).toBe("Original task");
  });
});

describe("push panel", () => {
  const JIRA_CHOICE = { provider: "JIRA" as const, label: "Jira" };

  it("points at Integrations instead of offering a push with nothing connected", () => {
    const markup = renderToStaticMarkup(
      createElement(PushPanel, {
        requirementId: "req_1",
        choices: [],
        hasDraft: true,
      }),
    );

    expect(markup).toContain("No tools connected yet");
    expect(markup).toContain("/dashboard/integrations");
    expect(markup).not.toContain('name="providers"');
  });

  it("offers each connected tool as a ticked destination", () => {
    const markup = renderToStaticMarkup(
      createElement(PushPanel, {
        requirementId: "req_1",
        choices: [JIRA_CHOICE, { provider: "NOTION" as const, label: "Notion" }],
        hasDraft: true,
      }),
    );

    expect(markup).toContain('value="JIRA"');
    expect(markup).toContain('value="NOTION"');
    expect(markup).toContain('value="req_1"');
    // The attribute, not the `disabled:` utility class the button always carries.
    expect(markup).not.toContain('disabled=""');
  });

  it("will not push a requirement that has no draft yet", () => {
    const markup = renderToStaticMarkup(
      createElement(PushPanel, {
        requirementId: "req_1",
        choices: [JIRA_CHOICE],
        hasDraft: false,
      }),
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Generate a draft before pushing");
  });
});

describe("draft editor rendering", () => {
  const story = {
    id: "story_1",
    title: "Request a password reset",
    description: "As a signed-out user, I want a reset link.",
    acceptanceCriteria: ["Given a, When b, Then c.", "Given d, Then e."],
    order: 0,
    tasks: [
      {
        id: "task_1",
        title: "Add reset endpoint",
        description: "POST /auth/reset",
        order: 0,
      },
      { id: "task_2", title: "Send the email", description: null, order: 1 },
    ],
  };

  it("renders every editable field with its current value", () => {
    const markup = renderToStaticMarkup(
      createElement(DraftEditor, { stories: [story] }),
    );

    expect(markup).toContain("Request a password reset");
    expect(markup).toContain("As a signed-out user, I want a reset link.");
    // Criteria are edited as one line per criterion.
    expect(markup).toContain("Given a, When b, Then c.\nGiven d, Then e.");
    expect(markup).toContain("Add reset endpoint");
    expect(markup).toContain("Send the email");
    expect(markup).toContain('name="storyId"');
    expect(markup).toContain('name="taskId"');
  });

  it("says so plainly when a requirement has no stories yet", () => {
    const markup = renderToStaticMarkup(
      createElement(DraftEditor, { stories: [] }),
    );

    expect(markup).toContain("No stories yet");
  });
});
