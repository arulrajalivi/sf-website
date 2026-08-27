"use client";

import Link from "next/link";
import { useActionState } from "react";

import type { Provider } from "@/generated/prisma/enums";

import {
  IDLE_PUSH_STATE,
  pushRequirementAction,
  type PushActionState,
} from "./actions";

/**
 * The push control.
 *
 * Destinations are ticked, not implied: a push is a write into someone else's
 * tracker, so the tools it will reach are visible before the click. Only
 * connected providers are offered — a checkbox for a tool that would certainly
 * fail is an invitation to a failed push.
 *
 * The result summary is deliberately thin. Per-item outcomes belong in push
 * history, which is durable; this panel says how it went and points there.
 */

export interface PushTargetChoice {
  provider: Provider;
  label: string;
}

export function PushPanel({
  requirementId,
  choices,
  hasDraft,
}: {
  requirementId: string;
  choices: readonly PushTargetChoice[];
  hasDraft: boolean;
}) {
  const [state, formAction, isPending] = useActionState<
    PushActionState,
    FormData
  >(pushRequirementAction, IDLE_PUSH_STATE);

  if (choices.length === 0) {
    return (
      <div className="border-edge flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3">
        <p className="text-muted text-xs">
          No tools connected yet — connect Jira, Linear, or Notion to push this
          draft.{" "}
          <Link
            href="/dashboard/integrations"
            className="underline underline-offset-2"
          >
            Go to Integrations
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="border-edge flex flex-col gap-3 rounded-lg border p-4"
    >
      <input type="hidden" name="requirementId" value={requirementId} />

      <fieldset className="flex flex-wrap items-center gap-4">
        <legend className="sr-only">Tools to push to</legend>
        {choices.map((choice) => (
          <label key={choice.provider} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="providers"
              value={choice.provider}
              defaultChecked
              className="accent-foreground"
            />
            {choice.label}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending || !hasDraft}
          className="border-edge rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "Pushing…" : "Push to tools"}
        </button>
        {hasDraft ? null : (
          <p className="text-muted text-xs">
            Generate a draft before pushing it.
          </p>
        )}
        <PushOutcome state={state} isPending={isPending} />
      </div>
    </form>
  );
}

function PushOutcome({
  state,
  isPending,
}: {
  state: PushActionState;
  isPending: boolean;
}) {
  // A stale result next to a spinner reads as this run's outcome.
  if (isPending || state.status === "idle") return null;

  if (state.status === "error") {
    return <p className="text-xs text-red-600 dark:text-red-400">{state.message}</p>;
  }

  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className={state.failed > 0 ? "text-red-600 dark:text-red-400" : undefined}>
        {state.created} created
        {state.failed > 0 ? `, ${state.failed} failed` : ""} ·{" "}
        <Link href="/dashboard/push-history" className="underline underline-offset-2">
          See push history
        </Link>
      </p>
      {state.lines.map((line) => (
        <p key={line} className="text-muted">
          {line}
        </p>
      ))}
    </div>
  );
}
