import type { Provider } from "@/generated/prisma/enums";
import { providerDefinition } from "@/lib/integrations/providers";
import type { PushHistoryEntry } from "@/lib/push/store";

/**
 * The pure half of the push history page: records in, rows out.
 *
 * The page's job is to answer one question — "did my stories land, and where?"
 * — so records are grouped by requirement and each group carries its own
 * created/failed counts. Keeping that shaping out of JSX is what lets the
 * awkward cases (a failed record has no link, a deleted requirement still has
 * history) be asserted in a test instead of eyeballed in a browser.
 */

/** One name per provider, shared with the Integrations page. */
function labelOf(provider: Provider): string {
  return providerDefinition(provider).label;
}

/** Records with no requirement left to group under. */
export const ORPHANED_GROUP_KEY = "unknown-requirement";

export interface PushHistoryRowView {
  id: string;
  /** Tasks render indented under their story. */
  isTask: boolean;
  title: string;
  providerLabel: string;
  statusLabel: string;
  tone: "created" | "failed";
  /** Absent for failures — there is nothing on the other end to open. */
  link: { href: string; label: string } | null;
  error: string | null;
  pushedAtLabel: string;
}

export interface PushHistoryGroupView {
  key: string;
  requirementTitle: string;
  /** Null once the requirement is deleted; the rows still stand on their own. */
  requirementHref: string | null;
  createdCount: number;
  failedCount: number;
  rows: PushHistoryRowView[];
}

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/**
 * Groups history by requirement, newest group first.
 *
 * Order inside a group is the order the records came in (newest first from the
 * store), which is also push order reversed — a task sits next to the story it
 * belongs to because that is how the push wrote them.
 */
export function buildPushHistoryView(
  entries: readonly PushHistoryEntry[],
): PushHistoryGroupView[] {
  const groups = new Map<string, PushHistoryGroupView>();

  for (const entry of entries) {
    const key = entry.requirementId ?? ORPHANED_GROUP_KEY;
    const group = groups.get(key) ?? {
      key,
      requirementTitle: entry.requirementTitle ?? "Deleted requirement",
      requirementHref: entry.requirementId
        ? `/dashboard/requirements/${entry.requirementId}`
        : null,
      createdCount: 0,
      failedCount: 0,
      rows: [],
    };

    group.rows.push(toRow(entry));
    if (entry.status === "CREATED") group.createdCount += 1;
    else group.failedCount += 1;

    groups.set(key, group);
  }

  return [...groups.values()];
}

function toRow(entry: PushHistoryEntry): PushHistoryRowView {
  const created = entry.status === "CREATED";
  return {
    id: entry.id,
    isTask: entry.kind === "task",
    title: entry.itemTitle,
    providerLabel: labelOf(entry.provider),
    statusLabel: created ? "Created" : "Failed",
    tone: created ? "created" : "failed",
    link: linkFor(entry),
    // A failed record without a message would render an empty red row, so the
    // one thing the user came for gets a fallback rather than a blank.
    error: created
      ? null
      : (entry.error ?? "The provider rejected this item without saying why."),
    pushedAtLabel: TIMESTAMP_FORMAT.format(entry.pushedAt),
  };
}

/**
 * The "open in the tool" link.
 *
 * Only ever a URL the provider returned, never one this app assembles from an
 * id: a guessed link that 404s is worse than no link, because it reads as the
 * item being gone rather than the link being wrong.
 */
function linkFor(entry: PushHistoryEntry): { href: string; label: string } | null {
  if (entry.status !== "CREATED" || !entry.externalUrl) return null;
  return {
    href: entry.externalUrl,
    label: entry.externalId
      ? `${labelOf(entry.provider)} ${entry.externalId}`
      : `Open in ${labelOf(entry.provider)}`,
  };
}
