import type { Provider } from "@/generated/prisma/enums";
import type { ConnectErrorCode } from "@/lib/integrations/oauth";
import type { IntegrationRow } from "@/lib/integrations/store";
import type { ProviderDefinition } from "@/lib/integrations/types";

/**
 * The pure half of the Integrations page: rows plus configuration in, view model
 * out. Keeping the state machine out of JSX is what lets "expired shows
 * Reconnect" and "disconnecting clears the account label" be asserted in a unit
 * test rather than by reading markup.
 */

export type ConnectionTone = "connected" | "attention" | "idle" | "unavailable";

export interface ProviderCardView {
  provider: Provider;
  label: string;
  blurb: string;
  /** Text of the status pill. */
  status: string;
  tone: ConnectionTone;
  /** "jane@acme.com · Acme workspace", or null when nothing is connected. */
  account: string | null;
  /** Absent when the provider has no OAuth credentials configured. */
  connectHref: string | null;
  connectLabel: string;
  canDisconnect: boolean;
  /** Why the provider cannot be connected right now, if it cannot. */
  note: string | null;
}

export interface ProviderCardInput {
  definition: ProviderDefinition;
  integration: IntegrationRow | null;
  isConfigured: boolean;
  connectHref: string;
}

export function buildProviderCard({
  definition,
  integration,
  isConfigured,
  connectHref,
}: ProviderCardInput): ProviderCardView {
  const base = {
    provider: definition.provider,
    label: definition.label,
    blurb: definition.blurb,
    account: accountSummary(integration),
  };

  if (!isConfigured) {
    return {
      ...base,
      status: "Unavailable",
      tone: "unavailable",
      connectHref: null,
      connectLabel: "Connect",
      canDisconnect: false,
      note: `${definition.label} is not registered yet — set ${definition.clientIdEnv} and ${definition.clientSecretEnv} to enable it.`,
    };
  }

  if (integration?.status === "CONNECTED") {
    return {
      ...base,
      status: "Connected",
      tone: "connected",
      connectHref,
      connectLabel: "Reconnect",
      canDisconnect: true,
      note: null,
    };
  }

  if (integration?.status === "EXPIRED") {
    return {
      ...base,
      status: "Reconnect needed",
      tone: "attention",
      connectHref,
      connectLabel: "Reconnect",
      // Nothing is left to disconnect once tokens are cleared, and offering it
      // would suggest the dead grant is still doing something.
      canDisconnect: false,
      note: `${definition.label} rejected the stored token. Reconnect to keep pushing.`,
    };
  }

  return {
    ...base,
    status: "Not connected",
    tone: "idle",
    connectHref,
    connectLabel: "Connect",
    canDisconnect: false,
    note: null,
  };
}

function accountSummary(integration: IntegrationRow | null): string | null {
  if (!integration || integration.status !== "CONNECTED") return null;
  const parts = [integration.accountLabel, integration.workspaceRef].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The banner shown after a connect attempt returns.
 *
 * Error codes are mapped to sentences here so nothing a provider sent is ever
 * reflected into the page, and an unrecognised code still says something true.
 */
export function connectNotice(input: {
  connected: string | null;
  error: string | null;
  provider: string | null;
}): { tone: "success" | "error"; message: string } | null {
  if (input.connected) {
    return { tone: "success", message: `${input.connected} is connected.` };
  }
  if (!input.error) return null;

  const subject = input.provider ?? "The provider";
  const messages: Record<ConnectErrorCode, string> = {
    unknown_provider: "That provider is not one this app supports.",
    not_configured: `${subject} is not registered with this app yet.`,
    denied: `${subject} did not grant access. Nothing was connected.`,
    invalid_state:
      "That connect attempt could not be verified — it may have expired. Please try again.",
    exchange_failed: `${subject} rejected the connection attempt. Please try again.`,
  };

  return {
    tone: "error",
    message:
      messages[input.error as ConnectErrorCode] ??
      "The connection attempt failed. Please try again.",
  };
}
