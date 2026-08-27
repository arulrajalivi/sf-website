import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Better Auth's Prisma adapter resolves models and fields by name. A rename in
 * schema.prisma therefore breaks sign-in at runtime rather than at compile time,
 * so the contract is asserted here instead of being left to a manual review.
 */
const schema = readFileSync(
  fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
  "utf8",
);

const REQUIRED_MODEL_FIELDS: Record<string, readonly string[]> = {
  User: ["id", "name", "email", "emailVerified", "image"],
  Session: ["id", "token", "expiresAt", "ipAddress", "userAgent", "userId"],
  Account: [
    "id",
    "accountId",
    "providerId",
    "accessToken",
    "refreshToken",
    "idToken",
    "accessTokenExpiresAt",
    "refreshTokenExpiresAt",
    "scope",
    "userId",
  ],
  Verification: ["id", "identifier", "value", "expiresAt"],
};

function modelBody(model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${model} is missing from schema.prisma`);
  return match[1];
}

describe("prisma schema — Better Auth contract", () => {
  it("targets PostgreSQL", () => {
    expect(schema).toMatch(/datasource db \{[\s\S]*provider\s*=\s*"postgresql"/);
  });

  for (const [model, fields] of Object.entries(REQUIRED_MODEL_FIELDS)) {
    it(`declares ${model} with the fields Better Auth reads`, () => {
      const body = modelBody(model);
      for (const field of fields) {
        expect(body).toMatch(new RegExp(`^\\s*${field}\\s`, "m"));
      }
    });
  }

  it("stores sessions in the database, keyed to a user", () => {
    expect(modelBody("Session")).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
  });
});

/**
 * The committed migrations are what actually reaches a database. Prisma will not
 * warn if a model is added to the schema and no migration follows, so the table
 * for every model is asserted to exist in the migration history.
 */
describe("prisma migrations", () => {
  const migrationSql = readFileSync(
    fileURLToPath(
      new URL(
        "../prisma/migrations/20260827000000_init/migration.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it.each(Object.keys(REQUIRED_MODEL_FIELDS))(
    "creates the table backing %s",
    (model) => {
      const table = modelBody(model).match(/@@map\("([^"]+)"\)/)?.[1];
      expect(table, `${model} must declare an @@map table name`).toBeDefined();
      expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
    },
  );
});
