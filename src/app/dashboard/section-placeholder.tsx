import { DASHBOARD_NAV_ITEMS } from "./nav-items";

/**
 * The empty state a dashboard section shows before its wave lands. It says what
 * the section will do rather than rendering a blank panel, so the shell is
 * navigable and self-explaining while the features are still being built.
 */
export function SectionPlaceholder({ href }: { href: string }) {
  const item = DASHBOARD_NAV_ITEMS.find((navItem) => navItem.href === href);
  if (!item) {
    // A section page pointing at an href the nav does not know about is a bug,
    // not an empty state — fail loudly rather than render a blank page.
    throw new Error(`No dashboard nav item registered for ${href}`);
  }

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{item.label}</h1>
      <p className="text-muted max-w-prose text-sm">{item.description}</p>
      <p className="border-edge text-muted rounded-md border border-dashed px-4 py-8 text-center text-sm">
        Nothing here yet — this section arrives in a later change.
      </p>
    </section>
  );
}
