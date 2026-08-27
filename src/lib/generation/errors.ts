/**
 * Generation failures, named.
 *
 * "Generation failed" tells a user nothing they can act on. Every failure mode
 * below has a different next move — wait and retry, fix a deploy, or retry
 * because the model produced junk — so the cause travels with the error and the
 * UI renders the sentence that matches it.
 */

export const GENERATION_ERROR_CODES = [
  "missing_api_key",
  "rate_limit",
  "provider_unavailable",
  "provider_error",
  "network",
  "invalid_output",
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  /** Provider-side detail, safe to log; never rendered verbatim to the user. */
  readonly detail?: string;

  constructor(
    code: GenerationErrorCode,
    detail?: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}${detail ? `: ${detail}` : ""}`, options);
    this.name = "GenerationError";
    this.code = code;
    this.detail = detail;
  }
}

export function isGenerationError(error: unknown): error is GenerationError {
  return error instanceof GenerationError;
}

const MESSAGES: Record<GenerationErrorCode, string> = {
  missing_api_key:
    "Generation is not configured on this deployment — OPENAI_API_KEY is missing. Your requirement is saved; retry once it is set.",
  rate_limit:
    "OpenAI rate-limited this request. Your requirement is saved — wait a moment and retry without retyping it.",
  provider_unavailable:
    "OpenAI is currently unavailable. Your requirement is saved — retry in a minute.",
  provider_error:
    "OpenAI rejected the request. Your requirement is saved; retry, and if it keeps failing check the configured model.",
  network:
    "Could not reach OpenAI. Your requirement is saved — check connectivity and retry.",
  invalid_output:
    "The model returned a draft that did not match the required story format, so nothing was saved from it. Your requirement is saved — retry.",
};

/** The sentence shown to the user for a failed generation. */
export function generationErrorMessage(code: GenerationErrorCode): string {
  return MESSAGES[code];
}
