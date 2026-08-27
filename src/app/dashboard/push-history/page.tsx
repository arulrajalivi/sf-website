import Link from "next/link";

import { listPushHistory } from "@/lib/push/store";
import { requireSession } from "@/lib/session";

import {
  buildPushHistoryView,
  type PushHistoryGroupView,
  type PushHistoryRowView,
} from "./history-view";

export const dynamic = "force-dynamic";

/**
 * Push history: every item this user sent to an external tool, and what became
 * of it. Created items link to the thing that was created; failed items say why,
 * because "some of it failed" without the reason is not something a person can
 * act on.
 */
export default async function PushHistoryPage() {
  const session = await requireSession();
  const groups = buildPushHistoryView(await listPushHistory(session.user.id));

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Push history</h1>
        <p className="text-muted max-w-prose text-sm">
          Every item pushed to an external tool, with its target and outcome.
        </p>
      </header>

      {groups.length === 0 ? (
        <p className="border-edge text-muted rounded-md border border-dashed px-4 py-8 text-center text-sm">
          Nothing pushed yet. Open a requirement, then push its draft to a
          connected tool.
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {groups.map((group) => (
            <li key={group.key}>
              <HistoryGroup group={group} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function HistoryGroup({ group }: { group: PushHistoryGroupView }) {
  return (
    <article className="border-edge flex flex-col gap-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">
          {group.requirementHref ? (
            <Link
              href={group.requirementHref}
              className="underline underline-offset-2"
            >
              {group.requirementTitle}
            </Link>
          ) : (
            group.requirementTitle
          )}
        </h2>
        <p className="text-muted text-xs">
          {group.createdCount} created
          {group.failedCount > 0 ? ` · ${group.failedCount} failed` : ""}
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {group.rows.map((row) => (
          <li key={row.id}>
            <HistoryRow row={row} />
          </li>
        ))}
      </ul>
    </article>
  );
}

function HistoryRow({ row }: { row: PushHistoryRowView }) {
  return (
    <div className={row.isTask ? "border-edge border-l pl-4" : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <StatusPill row={row} />
        <span>{row.title}</span>
        <span className="text-muted text-xs">
          {row.providerLabel} · {row.pushedAtLabel}
        </span>
        {row.link ? (
          <a
            href={row.link.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs underline underline-offset-2"
          >
            {row.link.label} ↗
          </a>
        ) : null}
      </div>
      {row.error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          {row.error}
        </p>
      ) : null}
    </div>
  );
}

function StatusPill({ row }: { row: PushHistoryRowView }) {
  const tone =
    row.tone === "created"
      ? "border-green-600/40 text-green-700 dark:text-green-400"
      : "border-red-600/40 text-red-700 dark:text-red-400";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${tone}`}>
      {row.statusLabel}
    </span>
  );
}
