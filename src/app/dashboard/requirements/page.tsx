import { requireSession } from "@/lib/session";

import { SectionPlaceholder } from "../section-placeholder";

export const dynamic = "force-dynamic";

export default async function RequirementsPage() {
  await requireSession();
  return <SectionPlaceholder href="/dashboard/requirements" />;
}
