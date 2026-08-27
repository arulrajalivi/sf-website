import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { resolveSocialProviders } from "./auth-providers";
import { optionalEnv, requireEnv } from "./env";
import { prisma } from "./prisma";

/**
 * Better Auth server instance.
 *
 * Built on first use rather than at module load: route modules are imported by
 * `next build`, and a missing BETTER_AUTH_SECRET should fail the request that
 * needs it, not the build. The instance is cached — Better Auth registers
 * routes and provider state on construction, so one per process is correct.
 */

const THIRTY_DAYS_IN_SECONDS = 60 * 60 * 24 * 30;
const ONE_DAY_IN_SECONDS = 60 * 60 * 24;

function createAuth() {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    secret: requireEnv("BETTER_AUTH_SECRET"),
    // Absent in local dev, where Better Auth infers the origin from the request.
    baseURL: optionalEnv("BETTER_AUTH_URL"),
    socialProviders: resolveSocialProviders(process.env),
    session: {
      expiresIn: THIRTY_DAYS_IN_SECONDS,
      updateAge: ONE_DAY_IN_SECONDS,
    },
    account: {
      accountLinking: {
        // All three providers assert a verified email, so the same person
        // arriving via Google today and GitHub tomorrow lands on one user
        // record instead of two silently divergent workspaces.
        enabled: true,
        trustedProviders: ["google", "microsoft", "github"],
      },
    },
  });
}

type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { authInstance?: Auth };

export function getAuth(): Auth {
  globalForAuth.authInstance ??= createAuth();
  return globalForAuth.authInstance;
}
