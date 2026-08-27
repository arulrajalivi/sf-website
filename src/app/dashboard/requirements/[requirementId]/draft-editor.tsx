"use client";

import { useActionState } from "react";

import type { DraftStory, DraftTask } from "@/lib/requirements/service";

import {
  IDLE_ACTION_STATE,
  generateDraftAction,
  saveStoryAction,
  saveTaskAction,
  type ActionState,
} from "../actions";
import { criteriaToText } from "../draft-form";

/**
 * The draft editor.
 *
 * Each story and each task is its own form posting to its own server action, so
 * a save is scoped to the thing being edited: one bad field cannot block the
 * rest of the draft, and two people (or two tabs) editing different stories do
 * not overwrite each other. Nothing here calls the model — regeneration is a
 * separate, explicitly labelled action because it discards edits.
 */

const FIELD_CLASS =
  "border-edge bg-surface focus:border-foreground w-full rounded-md border px-3 py-2 text-sm outline-none";

export function DraftEditor({ stories }: { stories: readonly DraftStory[] }) {
  if (stories.length === 0) {
    return (
      <p className="border-edge text-muted rounded-md border border-dashed px-4 py-8 text-center text-sm">
        No stories yet. Generate a draft to see stories and tasks here.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-6">
      {stories.map((story, index) => (
        <li key={story.id}>
          <StoryCard story={story} position={index + 1} />
        </li>
      ))}
    </ol>
  );
}

function StoryCard({
  story,
  position,
}: {
  story: DraftStory;
  position: number;
}) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    saveStoryAction,
    IDLE_ACTION_STATE,
  );

  return (
    <article className="border-edge flex flex-col gap-4 rounded-lg border p-4">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="storyId" value={story.id} />

        <div className="flex items-center gap-2">
          <span className="text-muted text-xs">Story {position}</span>
          <SaveStatus state={state} isPending={isPending} />
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium">
          Title
          <input
            name="title"
            defaultValue={story.title}
            required
            className={FIELD_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium">
          Description
          <textarea
            name="description"
            rows={3}
            defaultValue={story.description}
            className={FIELD_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium">
          Acceptance criteria
          <textarea
            name="acceptanceCriteria"
            rows={Math.max(3, story.acceptanceCriteria.length + 1)}
            defaultValue={criteriaToText(story.acceptanceCriteria)}
            className={FIELD_CLASS}
          />
          <span className="text-muted text-xs font-normal">
            One criterion per line.
          </span>
        </label>

        <div>
          <button
            type="submit"
            disabled={isPending}
            className="border-edge hover:bg-surface rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save story"}
          </button>
        </div>
      </form>

      <div className="flex flex-col gap-3">
        <h3 className="text-muted text-xs font-medium tracking-wide uppercase">
          Tasks
        </h3>
        {story.tasks.length === 0 ? (
          <p className="text-muted text-xs">No tasks on this story.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {story.tasks.map((task) => (
              <li key={task.id}>
                <TaskCard task={task} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function TaskCard({ task }: { task: DraftTask }) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    saveTaskAction,
    IDLE_ACTION_STATE,
  );

  return (
    <form
      action={formAction}
      className="border-edge flex flex-col gap-2 rounded-md border p-3"
    >
      <input type="hidden" name="taskId" value={task.id} />

      <input
        name="title"
        aria-label="Task title"
        defaultValue={task.title}
        required
        className={FIELD_CLASS}
      />
      <textarea
        name="description"
        aria-label="Task description"
        rows={2}
        defaultValue={task.description ?? ""}
        placeholder="Optional detail"
        className={FIELD_CLASS}
      />

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="border-edge hover:bg-surface rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60"
        >
          {isPending ? "Saving…" : "Save task"}
        </button>
        <SaveStatus state={state} isPending={isPending} />
      </div>
    </form>
  );
}

/** The three states a save can be in, each said out loud rather than implied. */
function SaveStatus({
  state,
  isPending,
}: {
  state: ActionState;
  isPending: boolean;
}) {
  if (isPending) return <span className="text-muted text-xs">Saving…</span>;
  if (state.status === "saved") {
    return (
      <span role="status" className="text-xs text-green-600">
        Saved
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <span role="alert" className="text-xs text-red-500">
        {state.message}
      </span>
    );
  }
  return null;
}

/**
 * Regeneration, kept away from the per-field saves: it replaces every story on
 * the requirement, so it says so on the button's own label rather than in a
 * tooltip nobody reads.
 */
export function RegenerateForm({
  requirementId,
  hasDraft,
}: {
  requirementId: string;
  hasDraft: boolean;
}) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    generateDraftAction,
    IDLE_ACTION_STATE,
  );

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="requirementId" value={requirementId} />
      <button
        type="submit"
        disabled={isPending}
        className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60"
      >
        {isPending
          ? "Generating…"
          : hasDraft
            ? "Regenerate (replaces edits)"
            : "Generate stories"}
      </button>
      {state.status === "error" ? (
        <span role="alert" className="text-sm text-red-500">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
