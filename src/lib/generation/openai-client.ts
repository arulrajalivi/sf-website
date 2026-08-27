import { optionalEnv, requireEnv } from "../env";

import { GenerationError } from "./errors";

/**
 * The OpenAI surface this app uses, expressed as one method.
 *
 * Two reasons for an interface instead of importing a vendor SDK directly:
 *  - Tests need a client that returns exactly the bytes under test (valid JSON,
 *    malformed JSON, a rate-limit error). An interface makes that a value, not a
 *    network interception.
 *  - The app calls one endpoint with one response format. A typed function is
 *    cheaper to reason about than an SDK surface we use 1% of.
 */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface JsonSchemaResponseFormat {
  name: string;
  schema: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: readonly ChatMessage[];
  responseFormat: JsonSchemaResponseFormat;
}

export interface OpenAIChatClient {
  /** Resolves with the assistant message content, or throws a GenerationError. */
  createChatCompletion(request: ChatCompletionRequest): Promise<string>;
}

/** Default model per the spec; pinned per deploy via OPENAI_MODEL. */
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

/**
 * The model this deploy is pinned to. A blank OPENAI_MODEL is treated as unset
 * rather than as a request for a model named "" — an empty string in a deploy's
 * environment is an omission, not a choice.
 */
export function resolveModel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

const OPENAI_CHAT_COMPLETIONS_URL =
  "https://api.openai.com/v1/chat/completions";

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FLOOR = 500;

/**
 * Live client. Reads the key per call — a key rotated in the environment takes
 * effect on the next request rather than on the next deploy, and a missing key
 * fails the request that needs it instead of the build that imports this module.
 */
export function createOpenAIChatClient(): OpenAIChatClient {
  return {
    async createChatCompletion({ model, messages, responseFormat }) {
      const apiKey = readApiKey();

      let response: Response;
      try {
        response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: responseFormat.name,
                schema: responseFormat.schema,
              },
            },
          }),
        });
      } catch (cause) {
        throw new GenerationError("network", describe(cause), { cause });
      }

      if (!response.ok) {
        throw new GenerationError(
          statusToCode(response.status),
          `HTTP ${response.status}: ${(await safeText(response)).slice(0, 500)}`,
        );
      }

      return extractContent(await safeJson(response));
    },
  };
}

function readApiKey(): string {
  if (!optionalEnv("OPENAI_API_KEY")) {
    // Named separately from a provider rejection: this one is a deploy problem,
    // and telling the user to "retry later" would be a lie.
    throw new GenerationError("missing_api_key", "OPENAI_API_KEY is not set");
  }
  return requireEnv("OPENAI_API_KEY");
}

function statusToCode(status: number) {
  if (status === HTTP_TOO_MANY_REQUESTS) return "rate_limit" as const;
  if (status >= HTTP_SERVER_ERROR_FLOOR) return "provider_unavailable" as const;
  return "provider_error" as const;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new GenerationError("provider_error", "response was not JSON", {
      cause,
    });
  }
}

/**
 * Pull the assistant content out of a chat completion. A refusal or a
 * length-truncated completion has no usable content — both are failures here
 * rather than a half-parsed draft downstream.
 */
function extractContent(payload: unknown): string {
  const choice = (
    payload as { choices?: { message?: { content?: unknown } }[] } | null
  )?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new GenerationError(
      "provider_error",
      "completion contained no message content",
    );
  }
  return content;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
