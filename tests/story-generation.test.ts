import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatCompletionRequest } from "@/lib/generation/openai-client";

import {
  fakeDb,
  fakePrisma,
  resetFakePrisma,
  seedRequirement,
} from "./support/fake-prisma";

/**
 * Generation, with OpenAI mocked.
 *
 * These assertions are about the two guarantees the spec names: a valid draft
 * becomes Story + Task rows, and an invalid one is rejected *before* anything is
 * persisted — with the raw requirement still there so a retry costs a click.
 */

vi.mock("@/lib/prisma", async () => {
  const { fakePrisma: client } = await import("./support/fake-prisma");
  return { prisma: client };
});

const {
  createRequirement,
  generateDraftForRequirement,
  deriveRequirementTitle,
  RequirementNotFoundError,
} = await import("@/lib/requirements/service");
const { GenerationError, generationErrorMessage } = await import(
  "@/lib/generation/errors"
);
const { DEFAULT_OPENAI_MODEL, resolveModel } = await import(
  "@/lib/generation/openai-client"
);
const { STORY_BREAKDOWN_SCHEMA_NAME } = await import(
  "@/lib/generation/story-breakdown"
);

type ChatRequest = ChatCompletionRequest;

const USER_ID = "user_1";
const OTHER_USER_ID = "user_2";
const REQUIREMENT_TEXT =
  "Users must be able to reset their password from the sign-in screen.";

const VALID_BREAKDOWN = {
  stories: [
    {
      title: "Request a password reset",
      description:
        "As a signed-out user, I want to request a reset link, so that I can regain access.",
      acceptanceCriteria: [
        "Given a registered email, When I submit the form, Then a reset link is sent.",
      ],
      tasks: [
        { title: "Add reset request endpoint", description: "POST /auth/reset" },
        { title: "Send reset email" },
      ],
    },
    {
      title: "Choose a new password",
      description:
        "As a user with a reset link, I want to set a new password, so that I can sign in again.",
      acceptanceCriteria: [
        "Given a valid token, When I submit a new password, Then it replaces the old one.",
        "Given an expired token, When I submit, Then I am told to request a new link.",
      ],
      tasks: [{ title: "Validate reset token" }],
    },
  ],
};

/** A client that replays a scripted response and records what it was asked. */
function stubClient(
  outcome: { content: string } | { throws: Error },
): {
  createChatCompletion: (request: ChatRequest) => Promise<string>;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async createChatCompletion(request: ChatRequest) {
      requests.push(request);
      if ("throws" in outcome) throw outcome.throws;
      return outcome.content;
    },
  };
}

beforeEach(() => {
  resetFakePrisma();
  delete process.env.OPENAI_MODEL;
});

describe("requirement intake", () => {
  it("saves the raw text before any model call happens", async () => {
    const requirement = await createRequirement({
      userId: USER_ID,
      rawText: `  ${REQUIREMENT_TEXT}  `,
    });

    expect(fakeDb.requirements).toHaveLength(1);
    expect(requirement.rawText).toBe(REQUIREMENT_TEXT);
    expect(fakeDb.storyCreateCalls).toBe(0);
  });

  it("titles a requirement from its first non-empty line", () => {
    expect(deriveRequirementTitle("\n\nReset passwords\nmore detail")).toBe(
      "Reset passwords",
    );
    expect(deriveRequirementTitle("   ")).toBe("Untitled requirement");
    expect(deriveRequirementTitle("x".repeat(200))).toHaveLength(80);
  });
});

describe("generation with valid model output", () => {
  it("persists a Story row per story and a Task row per task, in order", async () => {
    const requirement = await createRequirement({
      userId: USER_ID,
      rawText: REQUIREMENT_TEXT,
    });
    const client = stubClient({ content: JSON.stringify(VALID_BREAKDOWN) });

    const draft = await generateDraftForRequirement({
      userId: USER_ID,
      requirementId: requirement.id,
      client,
    });

    expect(fakeDb.stories).toHaveLength(2);
    expect(fakeDb.tasks).toHaveLength(3);
    expect(draft.stories.map((story) => story.title)).toEqual([
      "Request a password reset",
      "Choose a new password",
    ]);
    expect(draft.stories[0].acceptanceCriteria).toEqual(
      VALID_BREAKDOWN.stories[0].acceptanceCriteria,
    );
    expect(draft.stories[0].tasks.map((task) => task.title)).toEqual([
      "Add reset request endpoint",
      "Send reset email",
    ]);
    // A task the model gave no description for is null, not the string "undefined".
    expect(draft.stories[0].tasks[1].description).toBeNull();
    expect(draft.stories.map((story) => story.order)).toEqual([0, 1]);
  });

  it("sends the requirement text under the spec's schema name", async () => {
    const requirement = await createRequirement({
      userId: USER_ID,
      rawText: REQUIREMENT_TEXT,
    });
    const client = stubClient({ content: JSON.stringify(VALID_BREAKDOWN) });

    await generateDraftForRequirement({
      userId: USER_ID,
      requirementId: requirement.id,
      client,
    });

    const [request] = client.requests;
    expect(request.responseFormat.name).toBe(STORY_BREAKDOWN_SCHEMA_NAME);
    expect(request.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: REQUIREMENT_TEXT,
    });
  });

  it("regenerating replaces the previous draft rather than appending to it", async () => {
    const requirement = await createRequirement({
      userId: USER_ID,
      rawText: REQUIREMENT_TEXT,
    });
    const client = stubClient({ content: JSON.stringify(VALID_BREAKDOWN) });

    await generateDraftForRequirement({
      userId: USER_ID,
      requirementId: requirement.id,
      client,
    });
    await generateDraftForRequirement({
      userId: USER_ID,
      requirementId: requirement.id,
      client,
    });

    expect(fakeDb.stories).toHaveLength(2);
    expect(fakeDb.tasks).toHaveLength(3);
  });

  it("refuses to generate against another user's requirement", async () => {
    seedRequirement({
      id: "req_other",
      userId: OTHER_USER_ID,
      rawText: REQUIREMENT_TEXT,
    });
    const client = stubClient({ content: JSON.stringify(VALID_BREAKDOWN) });

    await expect(
      generateDraftForRequirement({
        userId: USER_ID,
        requirementId: "req_other",
        client,
      }),
    ).rejects.toBeInstanceOf(RequirementNotFoundError);
    expect(client.requests).toHaveLength(0);
    expect(fakeDb.storyCreateCalls).toBe(0);
  });
});

describe("generation with malformed model output", () => {
  const MALFORMED: Record<string, string> = {
    "text that is not JSON": "Here are your stories!",
    "JSON of the wrong shape": JSON.stringify({ stories: "two of them" }),
    "a story missing acceptance criteria": JSON.stringify({
      stories: [{ title: "T", description: "D", tasks: [] }],
    }),
    "a story with an empty title": JSON.stringify({
      stories: [
        { title: "  ", description: "D", acceptanceCriteria: [], tasks: [] },
      ],
    }),
    "an empty story list": JSON.stringify({ stories: [] }),
  };

  it.each(Object.entries(MALFORMED))(
    "rejects %s before writing any row",
    async (_label, content) => {
      const requirement = await createRequirement({
        userId: USER_ID,
        rawText: REQUIREMENT_TEXT,
      });

      const error = await generateDraftForRequirement({
        userId: USER_ID,
        requirementId: requirement.id,
        client: stubClient({ content }),
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(GenerationError);
      expect((error as InstanceType<typeof GenerationError>).code).toBe(
        "invalid_output",
      );
      expect(fakeDb.storyCreateCalls).toBe(0);
      expect(fakeDb.stories).toHaveLength(0);
      expect(fakeDb.tasks).toHaveLength(0);
    },
  );

  it("leaves an existing draft untouched when a regeneration returns junk", async () => {
    const requirement = await createRequirement({
      userId: USER_ID,
      rawText: REQUIREMENT_TEXT,
    });
    await generateDraftForRequirement({
      userId: USER_ID,
      requirementId: requirement.id,
      client: stubClient({ content: JSON.stringify(VALID_BREAKDOWN) }),
    });

    await expect(
      generateDraftForRequirement({
        userId: USER_ID,
        requirementId: requirement.id,
        client: stubClient({ content: "not json" }),
      }),
    ).rejects.toBeInstanceOf(GenerationError);

    expect(fakeDb.stories).toHaveLength(2);
  });
});

describe("failed generation is retryable without retyping", () => {
  it("keeps the raw text after a rate limit and succeeds on retry", async () => {
    const requirement = await createRequirement({
      userId: USER_ID,
      rawText: REQUIREMENT_TEXT,
    });

    const rateLimited = await generateDraftForRequirement({
      userId: USER_ID,
      requirementId: requirement.id,
      client: stubClient({
        throws: new GenerationError("rate_limit", "HTTP 429"),
      }),
    }).catch((thrown: unknown) => thrown);

    expect((rateLimited as InstanceType<typeof GenerationError>).code).toBe(
      "rate_limit",
    );
    expect(generationErrorMessage("rate_limit")).toContain("rate-limited");
    // The requirement — the part the user typed — survived the failure.
    expect(fakeDb.requirements[0].rawText).toBe(REQUIREMENT_TEXT);

    const draft = await generateDraftForRequirement({
      userId: USER_ID,
      requirementId: requirement.id,
      client: stubClient({ content: JSON.stringify(VALID_BREAKDOWN) }),
    });

    expect(draft.stories).toHaveLength(2);
    expect(draft.rawText).toBe(REQUIREMENT_TEXT);
  });

  it("names every failure cause with a distinct, actionable sentence", () => {
    const messages = (
      ["rate_limit", "invalid_output", "missing_api_key", "network"] as const
    ).map(generationErrorMessage);

    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message).not.toMatch(/^Generation failed\.?$/);
    }
  });
});

describe("model selection", () => {
  it("defaults to gpt-4o and honours OPENAI_MODEL", () => {
    expect(resolveModel({})).toBe(DEFAULT_OPENAI_MODEL);
    expect(resolveModel({ OPENAI_MODEL: "gpt-4o-mini" })).toBe("gpt-4o-mini");
    // A blank value in a deploy's env is absence, not a request for model "".
    expect(resolveModel({ OPENAI_MODEL: "  " })).toBe(DEFAULT_OPENAI_MODEL);
  });
});

describe("prisma double sanity", () => {
  it("shares one client between the service and the assertions", () => {
    expect(fakePrisma.requirement).toBeDefined();
  });
});
