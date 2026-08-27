import type { z } from "zod";

import type { Provider } from "@/generated/prisma/enums";

import { readJson } from "../integrations/http";
import type { IntegrationRow } from "../integrations/store";
import { withFreshToken } from "../integrations/tokens";

/**
 * The one way a push makes an authenticated provider call.
 *
 * Two things it centralises. The bearer token is attached here, from
 * `withFreshToken`, so no provider module ever holds a decrypted token in a
 * variable of its own — and a 401 is retried once with a refreshed token before
 * the caller ever sees it. And the response is read through the connectors'
 * `readJson`, so a push failure and a connect failure are the same two error
 * types rather than two dialects.
 */
export async function authorizedJson<TSchema extends z.ZodType>(input: {
  provider: Provider;
  operation: string;
  integration: IntegrationRow;
  url: string;
  schema: TSchema;
  init?: RequestInit;
}): Promise<z.infer<TSchema>> {
  const response = await withFreshToken(input.integration, (accessToken) =>
    fetch(input.url, {
      ...input.init,
      headers: {
        accept: "application/json",
        ...(input.init?.headers as Record<string, string> | undefined),
        authorization: `Bearer ${accessToken}`,
      },
    }),
  );

  return readJson({
    provider: input.provider,
    operation: input.operation,
    response,
    schema: input.schema,
  });
}

/** A JSON POST body with the content-type providers all require. */
export function jsonBody(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}
