import type { Provider, PushStatus } from "@/generated/prisma/enums";

import { findIntegration } from "../integrations/store";
import type { IntegrationRow } from "../integrations/store";
import { getRequirementDraft } from "../requirements/service";
import type { DraftStory, RequirementDraft } from "../requirements/service";
import { recordPush } from "./store";
import type { PushContext, PushResult, PushTarget } from "./types";

/**
 * Push orchestration: one draft, several external tools, one record per item.
 *
 * The rule this module exists to enforce is the spec's partial-push state — a
 * push is never all-or-nothing. Failure is contained at three levels:
 *
 *   provider → the other providers still run,
 *   story    → the next story still runs (its own tasks are recorded failed,
 *              because a subtask without its parent has nowhere to go),
 *   task     → the next task still runs.
 *
 * Every one of those outcomes is a row, so "what went where" is answerable from
 * the history rather than from whatever the browser happened to show.
 */

export type PushTargetRegistry = Record<Provider, PushTarget>;

export interface PushItemOutcome {
  kind: "story" | "task";
  storyId: string;
  taskId: string | null;
  title: string;
  status: PushStatus;
  externalUrl: string | null;
  error: string | null;
}

export interface ProviderPushOutcome {
  provider: Provider;
  /**
   * Set when the provider never got as far as individual items — not connected,
   * expired, or a failed pre-flight. Item-level failures live on the items.
   */
  error: string | null;
  created: number;
  failed: number;
  items: PushItemOutcome[];
}

export interface PushRunResult {
  requirementId: string;
  outcomes: ProviderPushOutcome[];
  created: number;
  failed: number;
}

/** Nothing was selected — the caller asked for a push with no destination. */
export class NoTargetsSelectedError extends Error {
  constructor() {
    super("Select at least one tool to push to.");
    this.name = "NoTargetsSelectedError";
  }
}

/** The requirement has no generated stories, so there is nothing to push. */
export class NothingToPushError extends Error {
  constructor() {
    super("Generate stories for this requirement before pushing it.");
    this.name = "NothingToPushError";
  }
}

/** The requirement does not exist, or belongs to someone else. */
export class PushRequirementNotFoundError extends Error {
  constructor(requirementId: string) {
    super(`No requirement ${requirementId} for this user`);
    this.name = "PushRequirementNotFoundError";
  }
}

/** Failure text is stored, so it is bounded before it reaches the column. */
const MAX_ERROR_CHARS = 500;

export async function pushRequirement(input: {
  userId: string;
  requirementId: string;
  providers: readonly Provider[];
  targets: PushTargetRegistry;
}): Promise<PushRunResult> {
  if (input.providers.length === 0) throw new NoTargetsSelectedError();

  const draft = await getRequirementDraft({
    userId: input.userId,
    requirementId: input.requirementId,
  });
  if (!draft) throw new PushRequirementNotFoundError(input.requirementId);
  if (draft.stories.length === 0) throw new NothingToPushError();

  const outcomes: ProviderPushOutcome[] = [];
  // Sequential rather than parallel: providers rate-limit per token, and a push
  // of a ten-story draft to three tools in parallel is the shape that gets an
  // account throttled. Isolation comes from the try/catch, not from concurrency.
  for (const provider of input.providers) {
    outcomes.push(
      await pushToProvider({
        provider,
        target: input.targets[provider],
        draft,
        userId: input.userId,
      }),
    );
  }

  return {
    requirementId: draft.id,
    outcomes,
    created: outcomes.reduce((total, outcome) => total + outcome.created, 0),
    failed: outcomes.reduce((total, outcome) => total + outcome.failed, 0),
  };
}

async function pushToProvider(input: {
  provider: Provider;
  target: PushTarget;
  draft: RequirementDraft;
  userId: string;
}): Promise<ProviderPushOutcome> {
  const integration = await findIntegration(input.userId, input.provider);

  // No row at all means the user never connected this provider. There is no
  // integration to attribute records to (the FK is not nullable), and inventing
  // one would put a failure in history that the user never asked for — the
  // outcome is reported to the caller instead.
  if (!integration) {
    return providerFailure(input.provider, [], {
      error: `${input.provider} is not connected — connect it on the Integrations page.`,
    });
  }

  const context: PushContext = {
    userId: input.userId,
    integration,
    requirement: { id: input.draft.id, title: input.draft.title },
    cache: new Map(),
  };

  try {
    await input.target.ensureFresh(integration);
  } catch (cause) {
    // A dead or unusable connection fails every item of this provider, and each
    // one is recorded: the user's question after a failed push is "which items
    // do I still have to move", and only per-item rows answer it.
    const reason = describe(cause);
    const items = await recordDraftFailure({
      draft: input.draft,
      integration,
      userId: input.userId,
      reason,
    });
    return providerFailure(input.provider, items, { error: reason });
  }

  const items: PushItemOutcome[] = [];
  for (const story of input.draft.stories) {
    items.push(
      ...(await pushStoryWithTasks({
        story,
        target: input.target,
        context,
        integration,
        userId: input.userId,
        requirementId: input.draft.id,
      })),
    );
  }

  return summarize(input.provider, items, null);
}

async function pushStoryWithTasks(input: {
  story: DraftStory;
  target: PushTarget;
  context: PushContext;
  integration: IntegrationRow;
  userId: string;
  requirementId: string;
}): Promise<PushItemOutcome[]> {
  const { story, target, context, integration, userId, requirementId } = input;

  let parent: PushResult;
  try {
    parent = await target.pushStory(story, context);
  } catch (cause) {
    const reason = describe(cause);
    const outcomes: PushItemOutcome[] = [
      await write({
        userId,
        integration,
        requirementId,
        storyId: story.id,
        taskId: null,
        title: story.title,
        status: "FAILED",
        result: null,
        error: reason,
      }),
    ];
    for (const task of story.tasks) {
      outcomes.push(
        await write({
          userId,
          integration,
          requirementId,
          storyId: story.id,
          taskId: task.id,
          title: task.title,
          status: "FAILED",
          result: null,
          error: `Its story could not be created (${reason})`,
        }),
      );
    }
    return outcomes;
  }

  const outcomes: PushItemOutcome[] = [
    await write({
      userId,
      integration,
      requirementId,
      storyId: story.id,
      taskId: null,
      title: story.title,
      status: "CREATED",
      result: parent,
      error: null,
    }),
  ];

  for (const task of story.tasks) {
    try {
      const result = await target.pushTask(task, parent, context);
      outcomes.push(
        await write({
          userId,
          integration,
          requirementId,
          storyId: story.id,
          taskId: task.id,
          title: task.title,
          status: "CREATED",
          result,
          error: null,
        }),
      );
    } catch (cause) {
      outcomes.push(
        await write({
          userId,
          integration,
          requirementId,
          storyId: story.id,
          taskId: task.id,
          title: task.title,
          status: "FAILED",
          result: null,
          error: describe(cause),
        }),
      );
    }
  }

  return outcomes;
}

/** Records every item of a draft as failed, for a provider-level failure. */
async function recordDraftFailure(input: {
  draft: RequirementDraft;
  integration: IntegrationRow;
  userId: string;
  reason: string;
}): Promise<PushItemOutcome[]> {
  const outcomes: PushItemOutcome[] = [];
  for (const story of input.draft.stories) {
    outcomes.push(
      await write({
        userId: input.userId,
        integration: input.integration,
        requirementId: input.draft.id,
        storyId: story.id,
        taskId: null,
        title: story.title,
        status: "FAILED",
        result: null,
        error: input.reason,
      }),
    );
    for (const task of story.tasks) {
      outcomes.push(
        await write({
          userId: input.userId,
          integration: input.integration,
          requirementId: input.draft.id,
          storyId: story.id,
          taskId: task.id,
          title: task.title,
          status: "FAILED",
          result: null,
          error: input.reason,
        }),
      );
    }
  }
  return outcomes;
}

/** Writes one record and returns the outcome the caller reports. */
async function write(input: {
  userId: string;
  integration: IntegrationRow;
  requirementId: string;
  storyId: string;
  taskId: string | null;
  title: string;
  status: PushStatus;
  result: PushResult | null;
  error: string | null;
}): Promise<PushItemOutcome> {
  await recordPush({
    userId: input.userId,
    integrationId: input.integration.id,
    provider: input.integration.provider,
    requirementId: input.requirementId,
    storyId: input.storyId,
    taskId: input.taskId,
    itemTitle: input.title,
    status: input.status,
    externalId: input.result?.externalId ?? null,
    externalUrl: input.result?.externalUrl ?? null,
    error: input.error,
  });

  return {
    kind: input.taskId === null ? "story" : "task",
    storyId: input.storyId,
    taskId: input.taskId,
    title: input.title,
    status: input.status,
    externalUrl: input.result?.externalUrl ?? null,
    error: input.error,
  };
}

function providerFailure(
  provider: Provider,
  items: PushItemOutcome[],
  { error }: { error: string },
): ProviderPushOutcome {
  return summarize(provider, items, error);
}

function summarize(
  provider: Provider,
  items: PushItemOutcome[],
  error: string | null,
): ProviderPushOutcome {
  return {
    provider,
    error,
    created: items.filter((item) => item.status === "CREATED").length,
    failed: items.filter((item) => item.status === "FAILED").length,
    items,
  };
}

/**
 * A thrown value as a line of history.
 *
 * Deliberately the error's `message` and never a ProviderRequestError's
 * `detail`: response bodies can carry account data, and this string is rendered
 * in the browser.
 */
function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, MAX_ERROR_CHARS);
}
