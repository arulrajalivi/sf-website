import { z } from "zod";

import type { IntegrationRow } from "../../integrations/store";
import { authorizedJson } from "../http";
import type {
  PushContext,
  PushResult,
  PushStoryInput,
  PushTarget,
  PushTaskInput,
} from "../types";
import { memoize, PushTargetError } from "../types";

/**
 * Notion: a story becomes a standalone page, its tasks become to-do blocks on
 * that page.
 *
 * Database targeting — mapping stories onto a database's properties — is a
 * deliberate fast-follow, not an omission. It needs the user to pick a database
 * and map fields, and shipping the page shape first means the push path works
 * for anyone who has simply shared a page with the integration.
 *
 * Notion pins its request/response shapes to a dated version header. It is sent
 * on every call because omitting it makes Notion pick a default that can change
 * under us.
 */

const API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const SearchResults = z.object({
  results: z.array(
    z.object({
      id: z.string().min(1),
      object: z.string(),
    }),
  ),
});

const CreatedPage = z.object({
  id: z.string().min(1),
  url: z.string().url(),
});

const AppendedBlocks = z.object({
  results: z.array(z.object({ id: z.string().min(1) })),
});

const CurrentUser = z.object({ id: z.string().min(1) });

/** JSON POST/PATCH with the version header Notion requires on every request. */
function notionRequest(method: "POST" | "PATCH", payload: unknown): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "notion-version": NOTION_VERSION,
    },
    body: JSON.stringify(payload),
  };
}

function versionHeaderOnly(): RequestInit {
  return { headers: { "notion-version": NOTION_VERSION } };
}

function richText(content: string): { text: { content: string } }[] {
  // Notion caps a single rich-text item at 2000 characters and rejects the whole
  // request over it, so a long generated description is chunked rather than lost.
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += 2000) {
    chunks.push(content.slice(index, index + 2000));
  }
  if (chunks.length === 0) chunks.push("");
  return chunks.map((chunk) => ({ text: { content: chunk } }));
}

function paragraph(content: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richText(content) },
  };
}

/** The story body: description, criteria as checkable items, provenance line. */
export function storyBlocks(
  story: PushStoryInput,
  requirementTitle: string,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [paragraph(story.description)];

  if (story.acceptanceCriteria.length > 0) {
    blocks.push({
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: richText("Acceptance criteria") },
    });
    for (const criterion of story.acceptanceCriteria) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText(criterion) },
      });
    }
  }

  blocks.push(paragraph(`From requirement: ${requirementTitle}`));
  return blocks;
}

/**
 * A page the integration can write to.
 *
 * Notion's OAuth grants access to whatever the user picked during connect, so
 * "which page do we create under" has exactly one honest answer available to us:
 * search what was shared. Nothing shared means nothing writable, and the error
 * says so in the user's terms.
 */
async function resolveParentPageId(ctx: PushContext): Promise<string> {
  return memoize(ctx, "notion:parentPageId", async () => {
    const found = await authorizedJson({
      provider: "NOTION",
      operation: "shared page search",
      integration: ctx.integration,
      url: `${API_BASE}/search`,
      schema: SearchResults,
      init: notionRequest("POST", {
        filter: { property: "object", value: "page" },
        page_size: 1,
      }),
    });

    const page = found.results[0];
    if (!page) {
      throw new PushTargetError({
        provider: "NOTION",
        message:
          "No Notion page is shared with this connection — share a page with the integration, then push again.",
      });
    }
    return page.id;
  });
}

/** Notion page URLs carry the id with the dashes stripped; blocks anchor on it. */
function blockAnchor(pageUrl: string, blockId: string): string {
  return `${pageUrl}#${blockId.replaceAll("-", "")}`;
}

export const notionTarget: PushTarget = {
  provider: "NOTION",

  async ensureFresh(integration: IntegrationRow): Promise<void> {
    await authorizedJson({
      provider: "NOTION",
      operation: "current user lookup",
      integration,
      url: `${API_BASE}/users/me`,
      schema: CurrentUser,
      init: versionHeaderOnly(),
    });
  },

  async pushStory(story: PushStoryInput, ctx: PushContext): Promise<PushResult> {
    const parentPageId = await resolveParentPageId(ctx);

    const page = await authorizedJson({
      provider: "NOTION",
      operation: "page create",
      integration: ctx.integration,
      url: `${API_BASE}/pages`,
      schema: CreatedPage,
      init: notionRequest("POST", {
        parent: { page_id: parentPageId },
        properties: {
          // A page under a page has exactly one property, and Notion names it
          // "title" — a database page would name it after the database column,
          // which is one reason database targeting is its own piece of work.
          title: { title: richText(story.title) },
        },
        children: storyBlocks(story, ctx.requirement.title),
      }),
    });

    // The tasks that follow append to this page, and they need its URL to build
    // a link that lands on the right block.
    ctx.cache.set(pageUrlKey(page.id), page.url);
    return { externalId: page.id, externalUrl: page.url };
  },

  async pushTask(
    task: PushTaskInput,
    parent: PushResult,
    ctx: PushContext,
  ): Promise<PushResult> {
    const appended = await authorizedJson({
      provider: "NOTION",
      operation: "to-do block append",
      integration: ctx.integration,
      url: `${API_BASE}/blocks/${parent.externalId}/children`,
      schema: AppendedBlocks,
      init: notionRequest("PATCH", {
        children: [
          {
            object: "block",
            type: "to_do",
            to_do: {
              rich_text: richText(
                task.description ? `${task.title} — ${task.description}` : task.title,
              ),
              checked: false,
            },
          },
        ],
      }),
    });

    const block = appended.results[0];
    if (!block) {
      throw new PushTargetError({
        provider: "NOTION",
        message: `Notion accepted the to-do for "${task.title}" but returned no block to link to.`,
      });
    }

    const pageUrl = ctx.cache.get(pageUrlKey(parent.externalId));
    return {
      externalId: block.id,
      externalUrl: blockAnchor(
        typeof pageUrl === "string" ? pageUrl : parent.externalUrl,
        block.id,
      ),
    };
  },
};

function pageUrlKey(pageId: string): string {
  return `notion:pageUrl:${pageId}`;
}
