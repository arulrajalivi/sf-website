import type { Provider, PushStatus } from "@/generated/prisma/enums";

import { prisma } from "../prisma";

/**
 * Every read and write of the push_record table.
 *
 * The history is written as the push runs rather than at the end: a process that
 * dies halfway through must still leave behind what it already created in the
 * user's Jira, or the app has issues it cannot tell anyone about.
 */

export interface PushRecordInput {
  userId: string;
  integrationId: string;
  provider: Provider;
  requirementId: string;
  storyId: string;
  /** Null when the record is for the story itself. */
  taskId: string | null;
  itemTitle: string;
  status: PushStatus;
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
}

export async function recordPush(input: PushRecordInput): Promise<void> {
  await prisma.pushRecord.create({ data: input });
}

/** One line of push history, already reduced to what the page renders. */
export interface PushHistoryEntry {
  id: string;
  provider: Provider;
  status: PushStatus;
  /** "story" or "task" — derived from which draft id the row carries. */
  kind: "story" | "task";
  itemTitle: string;
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
  pushedAt: Date;
  requirementId: string | null;
  /** Null once the requirement is gone; `itemTitle` still identifies the item. */
  requirementTitle: string | null;
}

const HISTORY_PAGE_SIZE = 200;

/**
 * The user's push history, newest first.
 *
 * Scoped by `userId` in the query rather than filtered afterwards: v1 has no
 * sharing, and the where clause is what makes that true instead of a convention
 * the next caller has to remember.
 */
export async function listPushHistory(
  userId: string,
  limit: number = HISTORY_PAGE_SIZE,
): Promise<PushHistoryEntry[]> {
  const rows = await prisma.pushRecord.findMany({
    where: { userId },
    orderBy: { pushedAt: "desc" },
    take: limit,
    select: {
      id: true,
      provider: true,
      status: true,
      itemTitle: true,
      externalId: true,
      externalUrl: true,
      error: true,
      pushedAt: true,
      taskId: true,
      requirementId: true,
      requirement: { select: { title: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    status: row.status,
    kind: row.taskId === null ? "story" : "task",
    itemTitle: row.itemTitle,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    error: row.error,
    pushedAt: row.pushedAt,
    requirementId: row.requirementId,
    requirementTitle: row.requirement?.title ?? null,
  }));
}
