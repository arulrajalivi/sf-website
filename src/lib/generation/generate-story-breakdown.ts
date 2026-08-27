import { GenerationError } from "./errors";
import {
  createOpenAIChatClient,
  resolveModel,
  type OpenAIChatClient,
} from "./openai-client";
import {
  STORY_BREAKDOWN_JSON_SCHEMA,
  STORY_BREAKDOWN_SCHEMA_NAME,
  SYSTEM_PROMPT_STORY_WRITER,
  storyBreakdownSchema,
  type StoryBreakdown,
} from "./story-breakdown";

/**
 * Requirement text → a validated story breakdown.
 *
 * This function never touches the database. Persisting a draft is the caller's
 * job precisely so that "the model returned nonsense" and "the rows were
 * written" cannot happen in the same code path — validation stands between the
 * two by construction, not by remembering to check.
 */
export async function generateStoryBreakdown(
  rawText: string,
  client: OpenAIChatClient = createOpenAIChatClient(),
): Promise<StoryBreakdown> {
  const content = await client.createChatCompletion({
    model: resolveModel(),
    responseFormat: {
      name: STORY_BREAKDOWN_SCHEMA_NAME,
      schema: STORY_BREAKDOWN_JSON_SCHEMA,
    },
    messages: [
      { role: "system", content: SYSTEM_PROMPT_STORY_WRITER },
      { role: "user", content: rawText },
    ],
  });

  return parseStoryBreakdown(content);
}

/**
 * Both failure modes of a model response — unparseable text and well-formed
 * JSON of the wrong shape — collapse to one `invalid_output` error, because the
 * user's move is identical in both cases: retry, nothing was saved.
 */
export function parseStoryBreakdown(content: string): StoryBreakdown {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (cause) {
    throw new GenerationError("invalid_output", "response was not JSON", {
      cause,
    });
  }

  const result = storyBreakdownSchema.safeParse(payload);
  if (!result.success) {
    throw new GenerationError(
      "invalid_output",
      result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    );
  }

  return result.data;
}
