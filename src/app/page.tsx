import { redirect } from "next/navigation";

/**
 * The app has no marketing surface: the root is a doorway. Signed-in visitors
 * land on the dashboard; everyone else is bounced to sign-in by the dashboard's
 * own guard, so the rule lives in exactly one place.
 */
export default function Home() {
  redirect("/dashboard");
}
