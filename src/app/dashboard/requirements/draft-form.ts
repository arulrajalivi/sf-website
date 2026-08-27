import { z } from "zod";

import { REQUIREMENT_TEXT_MAX_LENGTH } from "@/lib/requirements/limits";

/**
 * The shapes a browser can post, and the two translations between what a person
 * types and what the database stores.
 *
 * These are pure functions in their own module so the form's rules can be tested
 * without a DOM and reused by both the form and the server action — a server
 * action that trusted the client's parsing would be trusting the client.
 */

export const requirementInputSchema = z.object({
  rawText: z
    .string()
    .trim()
    .min(20, "Give the requirement a sentence or two so the model has something to work with.")
    .max(
      REQUIREMENT_TEXT_MAX_LENGTH,
      `Requirements are limited to ${REQUIREMENT_TEXT_MAX_LENGTH.toLocaleString("en-US")} characters.`,
    ),
});

export const storyEditSchema = z.object({
  storyId: z.string().min(1),
  title: z.string().trim().min(1, "A story needs a title."),
  description: z.string().trim(),
  acceptanceCriteria: z.string(),
});

export const taskEditSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().trim().min(1, "A task needs a title."),
  description: z.string().trim(),
});

/**
 * Acceptance criteria are edited as one-per-line text: a list of short Given/
 * When/Then sentences is what people paste, and a repeater widget would make the
 * common edit (retype the whole set) the slowest one.
 */
export function criteriaToText(criteria: readonly string[]): string {
  return criteria.join("\n");
}

export function textToCriteria(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The first message a failed parse should show, or null when it parsed. */
export function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input is not valid.";
}
