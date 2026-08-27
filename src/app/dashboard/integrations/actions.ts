"use server";

import { revalidatePath } from "next/cache";

import { INTEGRATIONS_PATH } from "@/lib/integrations/oauth";
import { parseProviderSlug } from "@/lib/integrations/providers";
import { disconnectIntegration } from "@/lib/integrations/store";
import { requireSession } from "@/lib/session";

/**
 * Disconnects a provider for the signed-in user.
 *
 * The user id comes from the session, never from the form: a hidden field
 * naming whose integration to drop would let any signed-in user disconnect
 * anyone else's. The form only says *which provider*.
 */
export async function disconnectProviderAction(
  formData: FormData,
): Promise<void> {
  const session = await requireSession();

  const provider = parseProviderSlug(String(formData.get("provider") ?? ""));
  if (!provider) {
    throw new Error("Unknown provider in disconnect request.");
  }

  await disconnectIntegration(session.user.id, provider);
  revalidatePath(INTEGRATIONS_PATH);
}
