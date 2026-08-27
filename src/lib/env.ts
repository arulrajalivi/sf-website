/**
 * Environment access, in one place, with two rules:
 *
 * 1. Nothing is read at module load — a missing variable must fail the request
 *    that needs it, not the build that merely imports it.
 * 2. A required variable that is absent throws by name. Silent fallbacks turn a
 *    misconfigured deploy into a mysterious 500 three layers away.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
