import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

import { requireEnv } from "./env";

/**
 * Prisma client as a lazily-constructed singleton behind a proxy.
 *
 * Two reasons for the indirection:
 *  - `next build` imports every route module. Constructing the client eagerly
 *    would make DATABASE_URL a build-time requirement for a step that never
 *    opens a connection.
 *  - Next.js dev reloads re-evaluate modules; caching on globalThis avoids
 *    leaking a new connection pool per reload.
 *
 * Prisma 7 talks to Postgres through a driver adapter rather than its own
 * engine binary, so the pg adapter is the connection.
 */

const globalForPrisma = globalThis as unknown as {
  prismaClient?: PrismaClient;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
  return new PrismaClient({ adapter });
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    globalForPrisma.prismaClient ??= createClient();
    return Reflect.get(globalForPrisma.prismaClient, property, receiver);
  },
});
