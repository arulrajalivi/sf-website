/**
 * The dashboard's sections, in one list.
 *
 * Every later wave (integrations, the requirement engine, push history) adds its
 * surface here rather than editing markup in two places; the nav and the section
 * pages cannot drift apart if they read from the same array.
 */

export interface DashboardNavItem {
  href: string;
  label: string;
  /** One line of what the section is for, shown on its placeholder page. */
  description: string;
}

export const DASHBOARD_NAV_ITEMS: readonly DashboardNavItem[] = [
  {
    href: "/dashboard/integrations",
    label: "Integrations",
    description:
      "Connect Jira, Linear, and Notion, and see the status of each connection.",
  },
  {
    href: "/dashboard/requirements",
    label: "Requirements",
    description:
      "Submit a requirement and review the generated stories and tasks before pushing them.",
  },
  {
    href: "/dashboard/push-history",
    label: "Push history",
    description:
      "Every item pushed to an external tool, with its target and outcome.",
  },
] as const;
