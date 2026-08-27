import { requireSession } from "@/lib/session";

import { SectionPlaceholder } from "../section-placeholder";

export const dynamic = "force-dynamic";

export default async function PushHistoryPage() {
  await requireSession();
  return <SectionPlaceholder href="/dashboard/push-history" />;
}
