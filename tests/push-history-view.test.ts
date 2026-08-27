import { describe, expect, it } from "vitest";

import type { PushHistoryEntry } from "@/lib/push/store";

import {
  ORPHANED_GROUP_KEY,
  buildPushHistoryView,
} from "@/app/dashboard/push-history/history-view";

/**
 * The push history view model.
 *
 * The case that matters is the mixed one: a push where Jira took the story and
 * Notion refused it must show both, with a working link on the one that landed
 * and the reason on the one that did not. That is the whole point of recording
 * per item rather than per push.
 */

const PUSHED_AT = new Date("2026-08-27T10:30:00Z");

function entry(overrides: Partial<PushHistoryEntry> = {}): PushHistoryEntry {
  return {
    id: "rec_1",
    provider: "JIRA",
    status: "CREATED",
    kind: "story",
    itemTitle: "Request a reset link",
    externalId: "PR-42",
    externalUrl: "https://acme.atlassian.net/browse/PR-42",
    error: null,
    pushedAt: PUSHED_AT,
    requirementId: "req_1",
    requirementTitle: "Password reset",
    ...overrides,
  };
}

describe("buildPushHistoryView", () => {
  it("groups a requirement's records together with its own counts", () => {
    const groups = buildPushHistoryView([
      entry({ id: "rec_1" }),
      entry({ id: "rec_2", kind: "task", itemTitle: "Add reset endpoint" }),
      entry({
        id: "rec_3",
        requirementId: "req_2",
        requirementTitle: "Audit log",
        itemTitle: "Record every write",
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].requirementTitle).toBe("Password reset");
    expect(groups[0].requirementHref).toBe("/dashboard/requirements/req_1");
    expect(groups[0].rows.map((row) => row.id)).toEqual(["rec_1", "rec_2"]);
    expect(groups[0].createdCount).toBe(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("shows what landed and what failed side by side in one push", () => {
    const [group] = buildPushHistoryView([
      entry({ id: "rec_1", provider: "JIRA" }),
      entry({
        id: "rec_2",
        provider: "NOTION",
        status: "FAILED",
        externalId: null,
        externalUrl: null,
        error: "Notion rejected the page: parent not found",
      }),
    ]);

    expect(group.createdCount).toBe(1);
    expect(group.failedCount).toBe(1);

    const [created, failed] = group.rows;
    expect(created.statusLabel).toBe("Created");
    expect(created.link).toEqual({
      href: "https://acme.atlassian.net/browse/PR-42",
      label: "Jira PR-42",
    });
    expect(created.error).toBeNull();

    expect(failed.statusLabel).toBe("Failed");
    expect(failed.link).toBeNull();
    expect(failed.error).toContain("parent not found");
    expect(failed.providerLabel).toBe("Notion");
  });

  it("never invents a link for a record the provider gave no URL for", () => {
    const [group] = buildPushHistoryView([
      entry({ status: "CREATED", externalUrl: null, externalId: "PR-42" }),
    ]);

    expect(group.rows[0].link).toBeNull();
  });

  it("gives a failure without a message something to say", () => {
    const [group] = buildPushHistoryView([
      entry({ status: "FAILED", error: null, externalUrl: null }),
    ]);

    expect(group.rows[0].error).toMatch(/without saying why/);
  });

  it("keeps history for a deleted requirement instead of dropping it", () => {
    const [group] = buildPushHistoryView([
      entry({ requirementId: null, requirementTitle: null }),
    ]);

    expect(group.key).toBe(ORPHANED_GROUP_KEY);
    expect(group.requirementTitle).toBe("Deleted requirement");
    expect(group.requirementHref).toBeNull();
    expect(group.rows[0].title).toBe("Request a reset link");
  });

  it("marks tasks so they render under their story", () => {
    const [group] = buildPushHistoryView([
      entry({ id: "rec_1", kind: "story" }),
      entry({ id: "rec_2", kind: "task" }),
    ]);

    expect(group.rows.map((row) => row.isTask)).toEqual([false, true]);
  });

  it("renders the push time in a fixed zone rather than the server's", () => {
    const [group] = buildPushHistoryView([entry()]);

    expect(group.rows[0].pushedAtLabel).toBe("Aug 27, 2026, 10:30 AM");
  });
});
