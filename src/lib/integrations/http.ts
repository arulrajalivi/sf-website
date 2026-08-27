import type { z } from "zod";

import type { Provider } from "@/generated/prisma/enums";

/**
 * The one place a provider's HTTP response becomes either typed data or a named
 * error. Every connector goes through it so a 401 is distinguishable from a 500
 * upstream — the refresh path branches on exactly that difference.
 */

export class ProviderRequestError extends Error {
  readonly provider: Provider;
  readonly status: number;
  /** Response body, truncated — useful in logs, never shown to the browser. */
  readonly detail: string;

  constructor(input: {
    provider: Provider;
    status: number;
    operation: string;
    detail: string;
  }) {
    super(
      `${input.provider} ${input.operation} failed with HTTP ${input.status}.`,
    );
    this.name = "ProviderRequestError";
    this.provider = input.provider;
    this.status = input.status;
    this.detail = input.detail;
  }
}

/** A provider answered with a shape we do not understand. */
export class ProviderResponseShapeError extends Error {
  readonly provider: Provider;

  constructor(input: { provider: Provider; operation: string; issues: string }) {
    super(
      `${input.provider} ${input.operation} returned an unexpected shape: ${input.issues}`,
    );
    this.name = "ProviderResponseShapeError";
    this.provider = input.provider;
  }
}

const MAX_DETAIL_CHARS = 500;

/**
 * Performs a request and parses the JSON body against `schema`.
 *
 * Parsing rather than casting is deliberate: a token endpoint that starts
 * returning `{error: ...}` with a 200 (they do) must fail here, not three layers
 * later when an undefined access token is encrypted and stored as the string
 * "undefined".
 */
export async function requestJson<TSchema extends z.ZodType>(input: {
  provider: Provider;
  operation: string;
  url: string;
  init: RequestInit;
  schema: TSchema;
}): Promise<z.infer<TSchema>> {
  const response = await fetch(input.url, input.init);
  return readJson({
    provider: input.provider,
    operation: input.operation,
    response,
    schema: input.schema,
  });
}

/**
 * Turns an already-performed response into typed data or a named error.
 *
 * Split out of `requestJson` because the push path cannot use it: those requests
 * go through `withFreshToken`, which owns the fetch so that it can retry a 401
 * with a refreshed token. Both paths must fail identically on a bad status or an
 * unexpected shape, and the only way to guarantee that is one implementation.
 */
export async function readJson<TSchema extends z.ZodType>(input: {
  provider: Provider;
  operation: string;
  response: Response;
  schema: TSchema;
}): Promise<z.infer<TSchema>> {
  if (!input.response.ok) {
    throw new ProviderRequestError({
      provider: input.provider,
      status: input.response.status,
      operation: input.operation,
      detail: (await safeText(input.response)).slice(0, MAX_DETAIL_CHARS),
    });
  }

  const body: unknown = await input.response.json().catch(() => undefined);
  const parsed = input.schema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderResponseShapeError({
      provider: input.provider,
      operation: input.operation,
      issues: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    });
  }

  return parsed.data;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}

/** Seconds-from-now to an absolute expiry, or null when the provider omits it. */
export function expiresAtFrom(
  expiresInSeconds: number | undefined,
  now: Date = new Date(),
): Date | null {
  return expiresInSeconds === undefined
    ? null
    : new Date(now.getTime() + expiresInSeconds * 1000);
}

/** Providers disagree on whether `scope` is a string or a list; store a string. */
export function normalizeScope(
  scope: string | readonly string[] | undefined | null,
): string | null {
  if (!scope) return null;
  return Array.isArray(scope) ? scope.join(" ") : (scope as string);
}
