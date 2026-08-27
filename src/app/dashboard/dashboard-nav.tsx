"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { DASHBOARD_NAV_ITEMS } from "./nav-items";

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Dashboard sections" className="flex flex-wrap gap-1">
      {DASHBOARD_NAV_ITEMS.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-surface" : "text-muted hover:bg-surface"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
