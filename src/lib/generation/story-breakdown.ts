import { z } from "zod";

/**
 * The contract between the model and the database, written twice on purpose.
 *
 * `STORY_BREAKDOWN_JSON_SCHEMA` is sent to OpenAI so the model is *constrained*
 * to the shape; `storyBreakdownSchema` re-checks the response before anything is
 * persisted. The second check is not redundant: structured outputs can still be
 * truncated by a length stop, a proxy can rewrite a body, and a future model or
 * a mocked client in a test can return anything at all. Only Zod's verdict
 * decides whether rows are written.
 */

const MAX_STORIES = 20;
const MAX_TASKS_PER_STORY = 20;

export const STORY_BREAKDOWN_SCHEMA_NAME = "story_breakdown";

export const STORY_BREAKDOWN_JSON_SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          // "As a … I want … so that …"
          description: { type: "string" },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
              },
              required: ["title"],
            },
          },
        },
        required: ["title", "description", "acceptanceCriteria", "tasks"],
      },
    },
  },
  required: ["stories"],
} as const;

const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});

const storySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)),
  tasks: z.array(taskSchema).max(MAX_TASKS_PER_STORY),
});

export const storyBreakdownSchema = z.object({
  stories: z.array(storySchema).min(1).max(MAX_STORIES),
});

export type StoryBreakdown = z.infer<typeof storyBreakdownSchema>;
export type GeneratedStory = z.infer<typeof storySchema>;
export type GeneratedTask = z.infer<typeof taskSchema>;

/**
 * What the model is asked to be. Kept next to the schema it must satisfy so the
 * instructions and the shape cannot drift apart.
 */
export const SYSTEM_PROMPT_STORY_WRITER = [
  "You are a senior product engineer breaking a requirement into implementable work.",
  "Return user stories in the form 'As a <role>, I want <capability>, so that <benefit>.'",
  "Every story carries Given/When/Then acceptance criteria that a tester could run without asking a question,",
  "and the tasks a developer would actually open to deliver it.",
  "Cover the requirement completely; invent nothing it does not imply.",
].join(" ");
