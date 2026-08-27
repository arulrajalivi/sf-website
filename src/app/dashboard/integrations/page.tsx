import type { Provider } from "@/generated/prisma/enums";
import {
  PROVIDERS,
  isProviderConfigured,
  providerDefinition,
  providerSlug,
} from "@/lib/integrations/providers";
import type { IntegrationRow } from "@/lib/integrations/store";
import { listIntegrations } from "@/lib/integrations/store";
import { requireSession } from "@/lib/session";

import { disconnectProviderAction } from "./actions";
import type { ProviderCardView } from "./connection-view";
import { buildProviderCard, connectNotice } from "./connection-view";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(params: SearchParams, key: string): string | null {
  const value = params[key];
  return typeof value === "string" ? value : null;
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireSession();
  const params = await searchParams;

  // A failed status read must not hide the providers themselves: the page still
  // renders, and says plainly that the statuses on it may be stale.
  let rows: IntegrationRow[] = [];
  let statusError = false;
  try {
    rows = await listIntegrations(session.user.id);
  } catch (cause) {
    statusError = true;
    console.error("[integrations] failed to load connection status:", cause);
  }

  const byProvider = new Map<Provider, IntegrationRow>(
    rows.map((row) => [row.provider, row]),
  );

  const cards = PROVIDERS.map((provider) => {
    const definition = providerDefinition(provider);
    return buildProviderCard({
      definition,
      integration: byProvider.get(provider) ?? null,
      isConfigured: isProviderConfigured(definition),
      connectHref: `/api/integrations/${providerSlug(provider)}/connect`,
    });
  });

  const notice = connectNotice({
    connected: firstValue(params, "connected"),
    error: firstValue(params, "error"),
    provider: firstValue(params, "provider"),
  });

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-muted max-w-prose text-sm">
          Connect the tools your stories and tasks are pushed to. Access is
          granted per account, stored encrypted, and can be revoked here at any
          time.
        </p>
      </header>

      {notice ? (
        <p
          role="status"
          className={`rounded-md border px-4 py-3 text-sm ${
            notice.tone === "success"
              ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-300"
              : "border-red-600/40 text-red-700 dark:text-red-300"
          }`}
        >
          {notice.message}
        </p>
      ) : null}

      {statusError ? (
        <p
          role="alert"
          className="rounded-md border border-amber-600/40 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
        >
          Connection status could not be loaded, so the states below may be out
          of date. Reload to try again.
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {cards.map((card) => (
          <li key={card.provider}>
            <ProviderCard card={card} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const TONE_CLASSES: Record<ProviderCardView["tone"], string> = {
  connected:
    "border-emerald-600/40 text-emerald-700 dark:text-emerald-300",
  attention: "border-amber-600/40 text-amber-700 dark:text-amber-300",
  idle: "border-edge text-muted",
  unavailable: "border-edge text-muted",
};

function ProviderCard({ card }: { card: ProviderCardView }) {
  return (
    <article className="border-edge flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium">{card.label}</h2>
          <span
            className={`rounded-full border px-2 py-0.5 text-xs ${TONE_CLASSES[card.tone]}`}
          >
            {card.status}
          </span>
        </div>
        <p className="text-muted max-w-prose text-sm">{card.blurb}</p>
        {card.account ? (
          <p className="text-sm">
            Connected as <span className="font-medium">{card.account}</span>
          </p>
        ) : null}
        {card.note ? (
          <p className="text-muted max-w-prose text-xs">{card.note}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {card.connectHref ? (
          <a
            href={card.connectHref}
            className="border-edge hover:bg-surface rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
          >
            {card.connectLabel}
          </a>
        ) : null}
        {card.canDisconnect ? (
          <form action={disconnectProviderAction}>
            <input
              type="hidden"
              name="provider"
              value={providerSlug(card.provider)}
            />
            <button
              type="submit"
              className="border-edge hover:bg-surface rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
            >
              Disconnect
            </button>
          </form>
        ) : null}
      </div>
    </article>
  );
}
