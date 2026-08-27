"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  IDLE_ACTION_STATE,
  submitRequirementAction,
  type ActionState,
} from "./actions";

/**
 * The requirement box.
 *
 * On failure the textarea is re-seeded from the server's echo of what was
 * submitted, and when the failure happened after the row was saved the error
 * carries a link straight to the saved requirement — the retry is a click, and
 * the typing is never the thing that is lost.
 */
export function RequirementForm() {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    submitRequirementAction,
    IDLE_ACTION_STATE,
  );

  const error = state.status === "error" ? state : null;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="rawText" className="text-sm font-medium">
        Requirement
      </label>
      <textarea
        id="rawText"
        name="rawText"
        rows={6}
        required
        defaultValue={error?.rawText ?? ""}
        placeholder="Describe what the product needs to do, in as much detail as you have."
        className="border-edge bg-surface focus:border-foreground w-full rounded-lg border px-3 py-2 text-sm outline-none"
      />

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-500"
        >
          {error.message}{" "}
          {error.requirementId ? (
            <Link
              href={`/dashboard/requirements/${error.requirementId}`}
              className="underline underline-offset-2"
            >
              Your text was saved — open it to retry.
            </Link>
          ) : null}
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={isPending}
          className="bg-foreground text-background rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {isPending ? "Generating…" : "Generate stories"}
        </button>
      </div>
    </form>
  );
}
