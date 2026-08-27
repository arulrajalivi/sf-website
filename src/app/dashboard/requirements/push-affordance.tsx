import Link from "next/link";

/**
 * The push control, in its only currently reachable state: disabled.
 *
 * The push engine and the connection registry are sibling changes. Rather than
 * hide the control until they land — which teaches people the product cannot do
 * it — the affordance is shown disabled with the reason and the one link that
 * fixes it. `connectedProviderCount` is a prop, not a query, so wiring it to the
 * real connection state later is a one-line change at the call site.
 */
export function PushAffordance({
  connectedProviderCount,
}: {
  connectedProviderCount: number;
}) {
  const isConnected = connectedProviderCount > 0;

  return (
    <div className="border-edge flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3">
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={
          isConnected
            ? "Pushing arrives with the push engine."
            : "Connect a tool before pushing."
        }
        className="border-edge text-muted cursor-not-allowed rounded-md border px-3 py-1.5 text-sm font-medium opacity-60"
      >
        Push to tool
      </button>
      <p className="text-muted text-xs">
        {isConnected
          ? "Pushing is not available yet."
          : "No tools connected yet — connect Jira, Linear, or Notion to push this draft."}{" "}
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

/**
 * How many providers this user has connected.
 *
 * Hard-coded to zero: the Integration model belongs to the connectors change and
 * does not exist in this branch's schema. Returning a constant from a named
 * function keeps the falsehood in one greppable place instead of scattering
 * `connectedProviderCount={0}` through the pages.
 */
export function connectedProviderCount(): number {
  return 0;
}
