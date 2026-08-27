import Link from "next/link";

import { listRequirements } from "@/lib/requirements/service";
import { requireSession } from "@/lib/session";

import { RequirementForm } from "./requirement-form";

export const dynamic = "force-dynamic";

export default async function RequirementsPage() {
  const session = await requireSession();
  const requirements = await listRequirements(session.user.id);

  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Requirements</h1>
        <p className="text-muted max-w-prose text-sm">
          Paste a requirement and review the generated stories and tasks before
          pushing them.
        </p>
      </header>

      <RequirementForm />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Your requirements</h2>
        {requirements.length === 0 ? (
          <p className="border-edge text-muted rounded-md border border-dashed px-4 py-8 text-center text-sm">
            Nothing yet — the requirements you submit will be listed here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {requirements.map((requirement) => (
              <li key={requirement.id}>
                <Link
                  href={`/dashboard/requirements/${requirement.id}`}
                  className="border-edge hover:bg-surface flex flex-col gap-1 rounded-lg border p-4 transition-colors"
                >
                  <span className="text-sm font-medium">
                    {requirement.title}
                  </span>
                  <span className="text-muted text-xs">
                    {requirement.storyCount === 0
                      ? "No draft yet"
                      : `${requirement.storyCount} ${requirement.storyCount === 1 ? "story" : "stories"}`}{" "}
                    · {requirement.createdAt.toISOString().slice(0, 10)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
