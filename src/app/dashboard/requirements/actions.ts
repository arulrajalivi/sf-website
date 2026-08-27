"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Provider } from "@/generated/prisma/enums";
import { GenerationError, generationErrorMessage } from "@/lib/generation/errors";
import {
  NoTargetsSelectedError,
  NothingToPushError,
  PushRequirementNotFoundError,
  pushRequirement,
} from "@/lib/push/service";
import { pushTargets } from "@/lib/push/targets";
import {
  RequirementNotFoundError,
  StoryNotFoundError,
  createRequirement,
  generateDraftForRequirement,
  updateStoryDraft,
  updateTaskDraft,
} from "@/lib/requirements/service";
import { requireSession } from "@/lib/session";

import {
  firstIssueMessage,
  requirementInputSchema,
  storyEditSchema,
  taskEditSchema,
  textToCriteria,
} from "./draft-form";

/**
 * Server actions for the requirement surface.
 *
 * Each one re-derives the session rather than trusting an id from the form: a
 * server action is a public endpoint, and the only thing standing between one
 * user's draft and another's is the `userId` these functions pass down.
 */

export type ActionState =
  | { status: "idle" }
  | { status: "saved" }
  /** `rawText` is echoed back so a failed submit never costs the typing. */
  | {
      status: "error";
      message: string;
      rawText?: string;
      requirementId?: string;
    };

export const IDLE_ACTION_STATE: ActionState = { status: "idle" };

const REQUIREMENTS_PATH = "/dashboard/requirements";
const PUSH_HISTORY_PATH = "/dashboard/push-history";

/**
 * The outcome of a push, as the requirement page shows it.
 *
 * `done` covers partial success as well as total success — a push to three
 * tools where one fails is the normal case this feature exists to survive, so
 * the state carries counts and one line per provider rather than a boolean.
 */
export type PushActionState =
  | { status: "idle" }
  | { status: "done"; created: number; failed: number; lines: string[] }
  | { status: "error"; message: string };

export const IDLE_PUSH_STATE: PushActionState = { status: "idle" };

/**
 * Pushes a saved draft to the tools the user ticked.
 *
 * Providers come from the form, so they are validated against the enum before
 * they reach the registry: an unknown value would otherwise index it to
 * `undefined` and fail as a crash instead of a message.
 */
export async function pushRequirementAction(
  _previous: PushActionState,
  formData: FormData,
): Promise<PushActionState> {
  const session = await requireSession();
  const requirementId = String(formData.get("requirementId") ?? "");
  if (!requirementId) {
    return { status: "error", message: "That requirement is no longer available." };
  }

  const providers = formData
    .getAll("providers")
    .map(String)
    .filter((value): value is Provider => value in pushTargets);

  try {
    const result = await pushRequirement({
      userId: session.user.id,
      requirementId,
      providers,
      targets: pushTargets,
    });

    revalidatePath(PUSH_HISTORY_PATH);
    return {
      status: "done",
      created: result.created,
      failed: result.failed,
      lines: result.outcomes.map(
        (outcome) =>
          `${outcome.provider}: ${outcome.created} created, ${outcome.failed} failed` +
          (outcome.error ? ` — ${outcome.error}` : ""),
      ),
    };
  } catch (error) {
    // Only the three conditions the user can fix are turned into messages; an
    // unexpected failure keeps its stack rather than being flattened to prose.
    if (
      error instanceof NoTargetsSelectedError ||
      error instanceof NothingToPushError
    ) {
      return { status: "error", message: error.message };
    }
    if (error instanceof PushRequirementNotFoundError) {
      return { status: "error", message: "That requirement is no longer available." };
    }
    throw error;
  }
}

/**
 * Saves the requirement, then generates. The save is committed first and on its
 * own so that a model failure leaves the user one click from a retry instead of
 * facing an empty textarea.
 */
export async function submitRequirementAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();

  const parsed = requirementInputSchema.safeParse({
    rawText: formData.get("rawText"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: firstIssueMessage(parsed.error),
      rawText: String(formData.get("rawText") ?? ""),
    };
  }

  const requirement = await createRequirement({
    userId: session.user.id,
    rawText: parsed.data.rawText,
  });

  const failure = await runGeneration(session.user.id, requirement.id);
  if (failure) {
    return { ...failure, rawText: requirement.rawText };
  }

  revalidatePath(REQUIREMENTS_PATH);
  redirect(`${REQUIREMENTS_PATH}/${requirement.id}`);
}

/** Retry or regenerate for a requirement whose text is already saved. */
export async function generateDraftAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const requirementId = String(formData.get("requirementId") ?? "");
  if (!requirementId) {
    return { status: "error", message: "That requirement is no longer available." };
  }

  const failure = await runGeneration(session.user.id, requirementId);
  if (failure) return failure;

  revalidatePath(`${REQUIREMENTS_PATH}/${requirementId}`);
  return { status: "saved" };
}

/**
 * The one place a GenerationError becomes something a person can act on.
 * Returning `undefined` means the draft was written.
 */
async function runGeneration(
  userId: string,
  requirementId: string,
): Promise<Extract<ActionState, { status: "error" }> | undefined> {
  try {
    await generateDraftForRequirement({ userId, requirementId });
    return undefined;
  } catch (error) {
    if (error instanceof GenerationError) {
      return {
        status: "error",
        message: generationErrorMessage(error.code),
        requirementId,
      };
    }
    if (error instanceof RequirementNotFoundError) {
      return {
        status: "error",
        message: "That requirement is no longer available.",
      };
    }
    throw error;
  }
}

export async function saveStoryAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();

  const parsed = storyEditSchema.safeParse({
    storyId: formData.get("storyId"),
    title: formData.get("title"),
    description: formData.get("description"),
    acceptanceCriteria: formData.get("acceptanceCriteria"),
  });
  if (!parsed.success) {
    return { status: "error", message: firstIssueMessage(parsed.error) };
  }

  try {
    await updateStoryDraft({
      userId: session.user.id,
      storyId: parsed.data.storyId,
      edit: {
        title: parsed.data.title,
        description: parsed.data.description,
        acceptanceCriteria: textToCriteria(parsed.data.acceptanceCriteria),
      },
    });
  } catch (error) {
    if (error instanceof StoryNotFoundError) {
      return { status: "error", message: "That story is no longer available." };
    }
    throw error;
  }

  revalidatePath(REQUIREMENTS_PATH);
  return { status: "saved" };
}

export async function saveTaskAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();

  const parsed = taskEditSchema.safeParse({
    taskId: formData.get("taskId"),
    title: formData.get("title"),
    description: formData.get("description"),
  });
  if (!parsed.success) {
    return { status: "error", message: firstIssueMessage(parsed.error) };
  }

  try {
    await updateTaskDraft({
      userId: session.user.id,
      taskId: parsed.data.taskId,
      edit: {
        title: parsed.data.title,
        // An emptied description is absence, not an empty string in the column.
        description: parsed.data.description || null,
      },
    });
  } catch (error) {
    if (error instanceof StoryNotFoundError) {
      return { status: "error", message: "That task is no longer available." };
    }
    throw error;
  }

  revalidatePath(REQUIREMENTS_PATH);
  return { status: "saved" };
}
