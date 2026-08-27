import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A `fetch` stand-in that answers from recorded provider responses.
 *
 * Provider modules are the one part of this codebase whose correctness is a
 * claim about somebody else's API — the exact host, the exact body shape, the
 * exact field Jira calls `parent`. Fixtures let CI assert the request we build
 * and the response we parse without a live account, a network, or a rate limit,
 * and they fail loudly the day a captured shape stops matching the code.
 *
 * Fixtures live in `tests/fixtures/<provider>/` as trimmed captures of the
 * documented response bodies: only the fields the modules read are kept, so a
 * diff to one is a deliberate statement about what we depend on.
 */

const FIXTURE_ROOT = join(import.meta.dirname, "..", "fixtures");

export function loadFixture(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURE_ROOT, relativePath), "utf8"),
  ) as unknown;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or the raw string when it is not JSON. */
  body: unknown;
}

export interface RecordedReply {
  status?: number;
  body?: unknown;
}

export interface RecordedRoute {
  /** Substring or pattern the request URL must match. */
  url: string | RegExp;
  method?: string;
  /** A single reply, reused for every matching call. */
  reply?: RecordedReply;
  /**
   * Replies in order, one per call — the only honest way to express "401 first,
   * then 200 after the refresh". The last entry answers any further calls.
   */
  replies?: RecordedReply[];
}

export interface RecordedApi {
  /** Every request the code under test made, in order. */
  calls: RecordedCall[];
  callsTo(url: string | RegExp): RecordedCall[];
  restore(): void;
}

function matches(route: RecordedRoute, url: string, method: string): boolean {
  if (route.method && route.method.toUpperCase() !== method) return false;
  return typeof route.url === "string"
    ? url.includes(route.url)
    : route.url.test(url);
}

function urlMatches(pattern: string | RegExp, url: string): boolean {
  return typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
}

/**
 * Installs the fake `fetch` and returns the call log.
 *
 * An unmatched request throws rather than returning a 404: a provider module
 * calling an endpoint the test did not anticipate is exactly the surprise these
 * suites exist to catch, and a silent 404 would read as a normal error path.
 */
export function installRecordedApi(routes: RecordedRoute[]): RecordedApi {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  const used = new Map<RecordedRoute, number>();

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: normalizeHeaders(init?.headers),
      body: parseBody(init?.body),
    });

    const route = routes.find((candidate) => matches(candidate, url, method));
    if (!route) {
      throw new Error(`No recorded response for ${method} ${url}`);
    }

    const attempt = used.get(route) ?? 0;
    used.set(route, attempt + 1);
    const reply = route.replies
      ? (route.replies[Math.min(attempt, route.replies.length - 1)] ?? {})
      : (route.reply ?? {});

    const status = reply.status ?? 200;
    return new Response(
      reply.body === undefined ? null : JSON.stringify(reply.body),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return {
    calls,
    callsTo: (pattern) => calls.filter((call) => urlMatches(pattern, call.url)),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  return Object.fromEntries(
    entries.map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body ?? null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}
