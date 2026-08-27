import { prisma } from "../prisma";

import { generateStoryBreakdown } from "../generation/generate-story-breakdown";
import type { OpenAIChatClient } from "../generation/openai-client";
import type { StoryBreakdown } from "../generation/story-breakdown";

/**
 * The requirement → draft lifecycle, in one place.
 *
 * The ordering rule this module exists to enforce: the raw requirement text is
 * committed to Postgres *before* the model is called, and story rows are written
 * only from a Zod-validated breakdown. A generation that fails therefore costs
 * the user a retry click, never their typing, and a malformed completion leaves
 * no half-written draft behind.
 *
 * Every read and write is scoped by `userId`. v1 has no sharing — a requirement
 * belongs to exactly one person, and the query is what guarantees it rather than
 * a check the caller has to remember.
 */

export interface DraftTask {
  id: string;
  title: string;
  description: string | null;
  order: number;
}

export interface DraftStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  order: number;
  tasks: DraftTask[];
}

export interface RequirementDraft {
  id: string;
  title: string;
  rawText: string;
  createdAt: Date;
  stories: DraftStory[];
}

export interface RequirementSummary {
  id: string;
  title: string;
  createdAt: Date;
  storyCount: number;
}

const TITLE_MAX_LENGTH = 80;

/**
 * A requirement's list label. Derived rather than asked for: an extra "title"
 * field in front of a paste-a-requirement box is friction for something the
 * first line already says.
 */
export function deriveRequirementTitle(rawText: string): string {
  const firstLine =
    rawText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length === 0) return "Untitled requirement";
  if (firstLine.length <= TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Saves the requirement text. Deliberately does not generate anything. */
export async function createRequirement({
  userId,
  rawText,
}: {
  userId: string;
  rawText: string;
}): Promise<{ id: string; title: string; rawText: string }> {
  const trimmed = rawText.trim();
  const requirement = await prisma.requirement.create({
    data: { userId, rawText: trimmed, title: deriveRequirementTitle(trimmed) },
    select: { id: true, title: true, rawText: true },
  });
  return requirement;
}

/**
 * Generates (or regenerates) the draft for a requirement the user owns.
 *
 * Regeneration replaces the previous stories: a draft is one coherent breakdown
 * of the requirement, and merging two model runs would produce a set no reviewer
 * asked for. Edits are lost on regenerate — the UI says so before it runs.
 */
export async function generateDraftForRequirement({
  userId,
  requirementId,
  client,
}: {
  userId: string;
  requirementId: string;
  client?: OpenAIChatClient;
}): Promise<RequirementDraft> {
  const requirement = await prisma.requirement.findFirst({
    where: { id: requirementId, userId },
    select: { id: true, rawText: true },
  });
  if (!requirement) {
    throw new RequirementNotFoundError(requirementId);
  }

  // Throws GenerationError on a provider failure or invalid output; nothing
  // below runs in either case.
  const breakdown = await generateStoryBreakdown(requirement.rawText, client);

  await persistBreakdown(requirement.id, breakdown);

  const draft = await getRequirementDraft({ userId, requirementId });
  if (!draft) {
    throw new RequirementNotFoundError(requirementId);
  }
  return draft;
}

async function persistBreakdown(
  requirementId: string,
  breakdown: StoryBreakdown,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Cascade removes the tasks of the replaced stories.
    await tx.story.deleteMany({ where: { requirementId } });

    for (const [storyIndex, story] of breakdown.stories.entries()) {
      await tx.story.create({
        data: {
          requirementId,
          title: story.title,
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria,
          order: storyIndex,
          tasks: {
            create: story.tasks.map((task, taskIndex) => ({
              title: task.title,
              description: task.description ?? null,
              order: taskIndex,
            })),
          },
        },
      });
    }
  });
}

export async function listRequirements(
  userId: string,
): Promise<RequirementSummary[]> {
  const rows = await prisma.requirement.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      _count: { select: { stories: true } },
    },
  });

  return rows.map(({ id, title, createdAt, _count }) => ({
    id,
    title,
    createdAt,
    storyCount: _count.stories,
  }));
}

export async function getRequirementDraft({
  userId,
  requirementId,
}: {
  userId: string;
  requirementId: string;
}): Promise<RequirementDraft | null> {
  const requirement = await prisma.requirement.findFirst({
    where: { id: requirementId, userId },
    select: {
      id: true,
      title: true,
      rawText: true,
      createdAt: true,
      stories: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          title: true,
          description: true,
          acceptanceCriteria: true,
          order: true,
          tasks: {
            orderBy: { order: "asc" },
            select: { id: true, title: true, description: true, order: true },
          },
        },
      },
    },
  });

  return requirement ?? null;
}

/** Raised when a requirement does not exist *or* belongs to someone else. */
export class RequirementNotFoundError extends Error {
  constructor(requirementId: string) {
    super(`No requirement ${requirementId} for this user`);
    this.name = "RequirementNotFoundError";
  }
}

export interface StoryEdit {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

/**
 * Ownership is expressed as part of the write, not checked before it: an
 * `updateMany` filtered through the requirement's `userId` cannot touch another
 * user's row even under a race, and a count of zero is the "not yours" answer.
 */
export async function updateStoryDraft({
  userId,
  storyId,
  edit,
}: {
  userId: string;
  storyId: string;
  edit: StoryEdit;
}): Promise<void> {
  const { count } = await prisma.story.updateMany({
    where: { id: storyId, requirement: { userId } },
    data: {
      title: edit.title,
      description: edit.description,
      acceptanceCriteria: edit.acceptanceCriteria,
    },
  });
  if (count === 0) {
    throw new StoryNotFoundError(storyId);
  }
}

export interface TaskEdit {
  title: string;
  description: string | null;
}

export async function updateTaskDraft({
  userId,
  taskId,
  edit,
}: {
  userId: string;
  taskId: string;
  edit: TaskEdit;
}): Promise<void> {
  const { count } = await prisma.task.updateMany({
    where: { id: taskId, story: { requirement: { userId } } },
    data: { title: edit.title, description: edit.description },
  });
  if (count === 0) {
    throw new StoryNotFoundError(taskId);
  }
}

export class StoryNotFoundError extends Error {
  constructor(id: string) {
    super(`No draft item ${id} for this user`);
    this.name = "StoryNotFoundError";
  }
}
