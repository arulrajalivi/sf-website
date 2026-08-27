import type { Provider } from "@/generated/prisma/enums";

import type { IntegrationRow } from "../integrations/store";

/**
 * The shape every push destination speaks.
 *
 * Jira wants an ADF document and a subtask issue type, Linear wants a GraphQL
 * mutation and a blocker relation, Notion wants a page and to-do blocks. None of
 * that is visible above this file: the orchestrator iterates targets, calls
 * `pushStory` then `pushTask`, and writes one record per item. A fourth provider
 * is one module plus one registry entry.
 */

/** A task as the push path sees it — draft fields only, no Prisma row. */
export interface PushTaskInput {
  id: string;
  title: string;
  description: string | null;
}

/** A story and the tasks that belong under it, in draft order. */
export interface PushStoryInput {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  tasks: PushTaskInput[];
}

/** The requirement the draft came from, for provider-side context lines. */
export interface PushRequirementInput {
  id: string;
  title: string;
}

/**
 * Everything a provider module needs for one push run.
 *
 * `integration` carries the encrypted token columns; decryption happens inside
 * the module's request path (via `withFreshToken`) and nowhere else, which is
 * what keeps plaintext tokens out of the orchestrator, the actions and the UI.
 *
 * `cache` is a per-run memo for provider metadata — the Jira project and issue
 * types, the Linear team, the Notion parent page. It is a parameter rather than
 * module state because that metadata is scoped to one user's integration: a
 * process-wide cache would serve one user's Jira project to another's push.
 */
export interface PushContext {
  userId: string;
  integration: IntegrationRow;
  requirement: PushRequirementInput;
  cache: Map<string, unknown>;
}

/** What the external tool gave back: enough to link straight to the item. */
export interface PushResult {
  externalId: string;
  externalUrl: string;
}

export interface PushTarget {
  provider: Provider;
  /**
   * Confirms the stored token still works before any item is created,
   * refreshing it when it is expiring or rejected.
   *
   * A pre-flight exists so that a dead connection costs zero half-created
   * issues: the alternative is discovering the expiry on story three, with two
   * orphans already in the user's backlog.
   */
  ensureFresh(integration: IntegrationRow): Promise<void>;
  /** Story → Jira issue / Linear issue / Notion page. */
  pushStory(story: PushStoryInput, ctx: PushContext): Promise<PushResult>;
  /** Task → Jira subtask / Linear issue (blocking parent) / Notion to-do block. */
  pushTask(
    task: PushTaskInput,
    parent: PushResult,
    ctx: PushContext,
  ): Promise<PushResult>;
}

/**
 * A provider-side precondition the user has to fix — no Jira project, no Linear
 * team, no Notion page shared with the integration.
 *
 * Separate from ProviderRequestError because the message is written *for* the
 * user: an HTTP status tells them nothing, "share a page with the integration"
 * tells them exactly what to do next.
 */
export class PushTargetError extends Error {
  readonly provider: Provider;

  constructor(input: { provider: Provider; message: string }) {
    super(input.message);
    this.name = "PushTargetError";
    this.provider = input.provider;
  }
}

/** Runs `resolve` once per key for the life of a push run. */
export async function memoize<T>(
  ctx: PushContext,
  key: string,
  resolve: () => Promise<T>,
): Promise<T> {
  const cached = ctx.cache.get(key);
  if (cached !== undefined) return cached as T;
  const value = await resolve();
  ctx.cache.set(key, value);
  return value;
}
