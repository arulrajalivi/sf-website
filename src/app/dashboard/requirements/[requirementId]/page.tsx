import Link from "next/link";
import { notFound } from "next/navigation";

import { providerDefinition } from "@/lib/integrations/providers";
import { listIntegrations } from "@/lib/integrations/store";
import { getRequirementDraft } from "@/lib/requirements/service";
import { requireSession } from "@/lib/session";

import type { PushTargetChoice } from "../push-panel";
import { PushPanel } from "../push-panel";
import { DraftEditor, RegenerateForm } from "./draft-editor";

export const dynamic = "force-dynamic";

export default async function RequirementDraftPage({
  params,
}: {
  params: Promise<{ requirementId: string }>;
}) {
  const session = await requireSession();
  const { requirementId } = await params;

  const draft = await getRequirementDraft({
    userId: session.user.id,
    requirementId,
  });
  // Someone else's requirement is indistinguishable from a missing one — a 404
  // that only appears for rows you own would itself leak which ids exist.
  if (!draft) notFound();

  // Only live connections are offered as destinations. An EXPIRED row is left
  // out on purpose: its push would fail at the first call, and the Integrations
  // page is where reconnecting belongs.
  const choices: PushTargetChoice[] = (await listIntegrations(session.user.id))
    .filter((integration) => integration.status === "CONNECTED")
    .map((integration) => ({
      provider: integration.provider,
      label: providerDefinition(integration.provider).label,
    }));

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/dashboard/requirements"
          className="text-muted text-xs underline underline-offset-2"
        >
          ← All requirements
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{draft.title}</h1>
      </header>

      <details className="border-edge rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Requirement text
        </summary>
        <p className="text-muted mt-3 text-sm whitespace-pre-wrap">
          {draft.rawText}
        </p>
      </details>

      <div className="flex flex-col gap-3">
        <RegenerateForm
          requirementId={draft.id}
          hasDraft={draft.stories.length > 0}
        />
        <PushPanel
          requirementId={draft.id}
          choices={choices}
          hasDraft={draft.stories.length > 0}
        />
      </div>

      <DraftEditor stories={draft.stories} />
    </section>
  );
}
