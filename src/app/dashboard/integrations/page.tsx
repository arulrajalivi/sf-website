import { requireSession } from "@/lib/session";

import { SectionPlaceholder } from "../section-placeholder";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requireSession();
  return <SectionPlaceholder href="/dashboard/integrations" />;
}
