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
 * Linear: a story becomes an issue, each task becomes its own issue that blocks
 * the story.
 *
 * Linear has no subtask type — the closest true statement about "this work is
 * part of that story" is a blocking relation, which is also what makes the
 * story's own status honest: it cannot be done while its tasks are open.
 *
 * Everything here is one GraphQL endpoint, which means errors do not arrive as
 * HTTP statuses: a perfectly valid 200 can carry an `errors` array. That is why
 * every call goes through `graphql()` below rather than `authorizedJson`
 * directly — an unchecked 200 would let a failed create look like a success with
 * a missing id.
 */

const API_URL = "https://api.linear.app/graphql";

const GraphQLEnvelope = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(z.object({ message: z.string() }))
    .optional(),
});

const TeamsData = z.object({
  teams: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        key: z.string().min(1),
        name: z.string().min(1),
      }),
    ),
  }),
});

const IssueCreateData = z.object({
  issueCreate: z.object({
    success: z.boolean(),
    issue: z
      .object({
        id: z.string().min(1),
        identifier: z.string().min(1),
        url: z.string().url(),
      })
      .nullable(),
  }),
});

const RelationCreateData = z.object({
  issueRelationCreate: z.object({ success: z.boolean() }),
});

const ViewerData = z.object({
  viewer: z.object({ id: z.string().min(1) }),
});

/**
 * One GraphQL round trip, with Linear's in-body errors raised as failures.
 *
 * The response is parsed twice on purpose: once loosely, to see whether the
 * envelope carries errors, and once against the caller's schema, so a shape
 * change in `data` is a typed failure rather than an undefined read later.
 */
async function graphql<TSchema extends z.ZodType>(input: {
  integration: IntegrationRow;
  operation: string;
  query: string;
  variables: Record<string, unknown>;
  schema: TSchema;
}): Promise<z.infer<TSchema>> {
  const envelope = await authorizedJson({
    provider: "LINEAR",
    operation: input.operation,
    integration: input.integration,
    url: API_URL,
    schema: GraphQLEnvelope,
    init: jsonBody({ query: input.query, variables: input.variables }),
  });

  if (envelope.errors && envelope.errors.length > 0) {
    throw new PushTargetError({
      provider: "LINEAR",
      message: `Linear rejected the ${input.operation}: ${envelope.errors
        .map((error) => error.message)
        .join("; ")}`,
    });
  }

  return input.schema.parse(envelope.data) as z.infer<TSchema>;
}

const TEAMS_QUERY = `query PushTeams { teams(first: 1) { nodes { id key name } } }`;

const ISSUE_CREATE = `mutation PushIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;

const RELATION_CREATE = `mutation PushIssueRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

const VIEWER_QUERY = `query PushViewer { viewer { id } }`;

async function resolveTeamId(ctx: PushContext): Promise<string> {
  return memoize(ctx, "linear:teamId", async () => {
    const data = await graphql({
      integration: ctx.integration,
      operation: "team lookup",
      query: TEAMS_QUERY,
      variables: {},
      schema: TeamsData,
    });

    // The workspace's first team. Team selection is a fast-follow for the same
    // reason as Jira's project picker — it is a UI decision, not a blocker on
    // pushing anything at all.
    const team = data.teams.nodes[0];
    if (!team) {
      throw new PushTargetError({
        provider: "LINEAR",
        message:
          "No Linear team is visible to this connection — create a team, or reconnect with access to one.",
      });
    }
    return team.id;
  });
}

/** Markdown, which is what Linear's description field actually renders. */
export function toLinearDescription(input: {
  description: string;
  acceptanceCriteria?: readonly string[];
  footer?: string;
}): string {
  const sections = [input.description.trim()];

  if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
    sections.push(
      ["**Acceptance criteria**", ...input.acceptanceCriteria.map((c) => `- ${c}`)].join(
        "\n",
      ),
    );
  }

  if (input.footer) sections.push(`_${input.footer}_`);
  return sections.filter((section) => section.length > 0).join("\n\n");
}

async function createIssue(input: {
  ctx: PushContext;
  title: string;
  description: string;
  operation: string;
}): Promise<{ id: string } & PushResult> {
  const teamId = await resolveTeamId(input.ctx);
  const data = await graphql({
    integration: input.ctx.integration,
    operation: input.operation,
    query: ISSUE_CREATE,
    variables: {
      input: { teamId, title: input.title, description: input.description },
    },
    schema: IssueCreateData,
  });

  const issue = data.issueCreate.issue;
  if (!data.issueCreate.success || !issue) {
    throw new PushTargetError({
      provider: "LINEAR",
      message: `Linear reported the ${input.operation} as unsuccessful and returned no issue.`,
    });
  }

  return {
    id: issue.id,
    // The identifier (ENG-42) is the handle a user recognises; the internal UUID
    // stays in `id` for the relation call that follows.
    externalId: issue.identifier,
    externalUrl: issue.url,
  };
}

export const linearTarget: PushTarget = {
  provider: "LINEAR",

  async ensureFresh(integration: IntegrationRow): Promise<void> {
    await graphql({
      integration,
      operation: "viewer lookup",
      query: VIEWER_QUERY,
      variables: {},
      schema: ViewerData,
    });
  },

  async pushStory(story: PushStoryInput, ctx: PushContext): Promise<PushResult> {
    const created = await createIssue({
      ctx,
      operation: "issue create",
      title: story.title,
      description: toLinearDescription({
        description: story.description,
        acceptanceCriteria: story.acceptanceCriteria,
        footer: `From requirement: ${ctx.requirement.title}`,
      }),
    });

    // `PushResult` carries the human identifier (ENG-42) because that is what a
    // record and a link need; the relation mutation wants the UUID, so the run
    // cache keeps the mapping for the tasks that follow.
    ctx.cache.set(issueIdKey(created.externalId), created.id);
    return { externalId: created.externalId, externalUrl: created.externalUrl };
  },

  async pushTask(
    task: PushTaskInput,
    parent: PushResult,
    ctx: PushContext,
  ): Promise<PushResult> {
    const created = await createIssue({
      ctx,
      operation: "task issue create",
      title: task.title,
      description: toLinearDescription({ description: task.description ?? "" }),
    });

    await graphql({
      integration: ctx.integration,
      operation: "issue relation create",
      query: RELATION_CREATE,
      variables: {
        input: {
          issueId: created.id,
          relatedIssueId: parentIssueId(ctx, parent),
          // The task blocks the story: Linear has no subtask, and "the story
          // cannot ship until this is done" is the true statement.
          type: "blocks",
        },
      },
      schema: RelationCreateData,
    });

    return { externalId: created.externalId, externalUrl: created.externalUrl };
  },
};

function issueIdKey(identifier: string): string {
  return `linear:issueId:${identifier}`;
}

/**
 * The parent story's internal Linear id, cached when the story was pushed.
 *
 * A miss can only mean a task was pushed without its story going first, which
 * the orchestrator never does — so it is raised rather than skipped. Silently
 * creating an unlinked issue would leave the user a loose task and no signal
 * that the link they asked for never happened.
 */
function parentIssueId(ctx: PushContext, parent: PushResult): string {
  const cached = ctx.cache.get(issueIdKey(parent.externalId));
  if (typeof cached !== "string") {
    throw new PushTargetError({
      provider: "LINEAR",
      message: `Linear issue ${parent.externalId} was not pushed in this run, so its task could not be linked to it.`,
    });
  }
  return cached;
}
