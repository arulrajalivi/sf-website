import { z } from "zod";

import type { IntegrationRow } from "../../integrations/store";
import { authorizedJson, jsonBody } from "../http";
import type {
  PushContext,
  PushResult,
  PushStoryInput,
  PushTarget,
  PushTaskInput,
} from "../types";
import { memoize, PushTargetError } from "../types";

/**
 * Jira Cloud: a story becomes an issue, its tasks become subtasks of it.
 *
 * Three Jira facts drive the shape of this module:
 *
 *  - Every REST path is built from the site's cloudId, which the connector
 *    already stored in `Integration.workspaceRef` at connect time. Without it
 *    there is no reachable API host, so a row missing it is a connection to
 *    reconnect, not a request to retry.
 *  - Descriptions are ADF (Atlassian Document Format), not text and not
 *    markdown. Sending a string to a v3 endpoint is a 400.
 *  - A subtask needs both a subtask-flavoured issue type and a parent key, and
 *    which types exist is per project — hence the createmeta-style lookup rather
 *    than a hardcoded "Sub-task".
 */

const API_HOST = "https://api.atlassian.com";

/** Enough of the project search response to pick a project and its types. */
const ProjectSearch = z.object({
  values: z.array(
    z.object({
      id: z.string().min(1),
      key: z.string().min(1),
      name: z.string().optional(),
      issueTypes: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            subtask: z.boolean().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

const ServerInfo = z.object({ baseUrl: z.string().url() });

const CreatedIssue = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
});

const Myself = z.object({ accountId: z.string().min(1) });

interface JiraProject {
  id: string;
  key: string;
  storyTypeId: string;
  subtaskTypeId: string;
}

function baseUrlFor(integration: IntegrationRow): string {
  if (!integration.workspaceRef) {
    throw new PushTargetError({
      provider: "JIRA",
      message:
        "This Jira connection has no site on file — reconnect it to choose a site.",
    });
  }
  return `${API_HOST}/ex/jira/${integration.workspaceRef}/rest/api/3`;
}

/**
 * Plain text as an ADF document.
 *
 * Deliberately paragraphs and a bullet list and nothing else: the generated
 * story text is prose and a list of criteria, and a richer converter would be
 * inventing formatting the model never expressed.
 */
export function toAdf(input: {
  description: string;
  acceptanceCriteria?: readonly string[];
  footer?: string;
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = paragraphs(input.description);

  if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
    content.push({
      type: "paragraph",
      content: [
        { type: "text", text: "Acceptance criteria", marks: [{ type: "strong" }] },
      ],
    });
    content.push({
      type: "bulletList",
      content: input.acceptanceCriteria.map((criterion) => ({
        type: "listItem",
        content: paragraphs(criterion),
      })),
    });
  }

  if (input.footer) content.push(...paragraphs(input.footer));

  return { type: "doc", version: 1, content };
}

function paragraphs(text: string): Record<string, unknown>[] {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  // An empty paragraph rather than an empty doc: ADF rejects a doc with no
  // content, and a task with no description is a normal thing to push.
  if (blocks.length === 0) return [{ type: "paragraph", content: [] }];
  return blocks.map((block) => ({
    type: "paragraph",
    content: [{ type: "text", text: block }],
  }));
}

async function resolveProject(ctx: PushContext): Promise<JiraProject> {
  return memoize(ctx, "jira:project", async () => {
    // `expand=issueTypes` answers "which project" and "which issue types" in one
    // round trip; asked separately they are two calls per push run.
    const search = await authorizedJson({
      provider: "JIRA",
      operation: "project search",
      integration: ctx.integration,
      url: `${baseUrlFor(ctx.integration)}/project/search?maxResults=1&orderBy=key&expand=issueTypes`,
      schema: ProjectSearch,
    });

    // v1 pushes to the site's first project by key. Project selection is a
    // deliberate fast-follow, not an oversight: it needs a UI decision the spec
    // parks, and defaulting is better than refusing to push at all.
    const project = search.values[0];
    if (!project) {
      throw new PushTargetError({
        provider: "JIRA",
        message:
          "No Jira project is visible to this connection — create one, or reconnect with access to it.",
      });
    }

    const types = project.issueTypes ?? [];
    const storyType =
      types.find((type) => !type.subtask && type.name === "Story") ??
      types.find((type) => !type.subtask && type.name === "Task") ??
      types.find((type) => !type.subtask);
    const subtaskType = types.find((type) => type.subtask);

    if (!storyType) {
      throw new PushTargetError({
        provider: "JIRA",
        message: `Jira project ${project.key} has no usable issue type for a story.`,
      });
    }
    if (!subtaskType) {
      throw new PushTargetError({
        provider: "JIRA",
        message: `Jira project ${project.key} has subtasks disabled, so tasks cannot be pushed.`,
      });
    }

    return {
      id: project.id,
      key: project.key,
      storyTypeId: storyType.id,
      subtaskTypeId: subtaskType.id,
    };
  });
}

/** The site's browsable base URL — `self` links point at the API, not the UI. */
async function resolveSiteUrl(ctx: PushContext): Promise<string> {
  return memoize(ctx, "jira:siteUrl", async () => {
    const info = await authorizedJson({
      provider: "JIRA",
      operation: "server info lookup",
      integration: ctx.integration,
      url: `${baseUrlFor(ctx.integration)}/serverInfo`,
      schema: ServerInfo,
    });
    return info.baseUrl.replace(/\/+$/, "");
  });
}

async function createIssue(input: {
  ctx: PushContext;
  fields: Record<string, unknown>;
  operation: string;
}): Promise<PushResult> {
  const created = await authorizedJson({
    provider: "JIRA",
    operation: input.operation,
    integration: input.ctx.integration,
    url: `${baseUrlFor(input.ctx.integration)}/issue`,
    schema: CreatedIssue,
    init: jsonBody({ fields: input.fields }),
  });

  const siteUrl = await resolveSiteUrl(input.ctx);
  return {
    // The key, not the numeric id: it is what the user sees in Jira and what
    // they can paste back to us when something looks wrong.
    externalId: created.key,
    externalUrl: `${siteUrl}/browse/${created.key}`,
  };
}

export const jiraTarget: PushTarget = {
  provider: "JIRA",

  async ensureFresh(integration: IntegrationRow): Promise<void> {
    // `myself` is the cheapest authenticated call Jira offers; going through
    // `authorizedJson` is what turns a 401 into a refresh-and-retry.
    await authorizedJson({
      provider: "JIRA",
      operation: "current user lookup",
      integration,
      url: `${baseUrlFor(integration)}/myself`,
      schema: Myself,
    });
  },

  async pushStory(
    story: PushStoryInput,
    ctx: PushContext,
  ): Promise<PushResult> {
    const project = await resolveProject(ctx);
    return createIssue({
      ctx,
      operation: "create issue",
      fields: {
        project: { id: project.id },
        issuetype: { id: project.storyTypeId },
        summary: story.title,
        description: toAdf({
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria,
          footer: `From requirement: ${ctx.requirement.title}`,
        }),
      },
    });
  },

  async pushTask(
    task: PushTaskInput,
    parent: PushResult,
    ctx: PushContext,
  ): Promise<PushResult> {
    const project = await resolveProject(ctx);
    return createIssue({
      ctx,
      operation: "create subtask",
      fields: {
        project: { id: project.id },
        issuetype: { id: project.subtaskTypeId },
        parent: { key: parent.externalId },
        summary: task.title,
        description: toAdf({ description: task.description ?? "" }),
      },
    });
  },
};
