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
    "issuer",
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

  it("keys the draft spine to its owner and cascades on delete", () => {
    // A requirement is one user's private draft in v1; the cascade is what makes
    // "delete my account" actually remove the drafts rather than orphan them.
    expect(modelBody("Requirement")).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(modelBody("Story")).toMatch(/onDelete: Cascade/);
    expect(modelBody("Task")).toMatch(/onDelete: Cascade/);
  });

  it("stores sessions in the database, keyed to a user", () => {
    expect(modelBody("Session")).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  /**
   * Better Auth 1.7.2's internal adapter (findAccountOwnerByKey /
   * findAccountByKey) looks an account up by (issuer, accountId) — not
   * (providerId, accountId). A future Better Auth bump that renames this key
   * again must fail this test instead of 500ing every OAuth callback.
   */
  it("keys Account lookups the way Better Auth 1.7.2's adapter queries them", () => {
    const body = modelBody("Account");
    expect(body).toMatch(/@@unique\(\[issuer, accountId\]\)/);
    expect(body).not.toMatch(/@@unique\(\[providerId, accountId\]\)/);
  });
});

/**
 * The committed migrations are what actually reaches a database. Prisma will not
 * warn if a model is added to the schema and no migration follows, so the table
 * for every model is asserted to exist in the migration history.
 */
describe("prisma migrations", () => {
  const migrationSql = readMigration("20260827000000_init");
  const draftMigrationSql = readMigration("20260827120000_requirement_story_task");
  const allMigrationSql = `${migrationSql}\n${draftMigrationSql}`;

  it.each(Object.keys(REQUIRED_MODEL_FIELDS))(
    "creates the table backing %s",
    (model) => {
      const table = modelBody(model).match(/@@map\("([^"]+)"\)/)?.[1];
      expect(table, `${model} must declare an @@map table name`).toBeDefined();
      expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
    },
  );

  it.each(["Requirement", "Story", "Task"])(
    "creates the table backing %s",
    (model) => {
      const table = modelBody(model).match(/@@map\("([^"]+)"\)/)?.[1];
      expect(table, `${model} must declare an @@map table name`).toBeDefined();
      expect(allMigrationSql).toContain(`CREATE TABLE "${table}"`);
    },
  );

  /**
   * The draft slice must not rewrite the auth foundation's migration: a
   * migration already applied to a database is immutable, and editing one in
   * place makes every existing deploy diverge from the repository silently.
   */
  it("adds the draft tables in a new migration rather than editing the applied one", () => {
    expect(migrationSql).not.toContain('CREATE TABLE "requirement"');
    expect(draftMigrationSql).toContain('CREATE TABLE "requirement"');
  });
});

function readMigration(name: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
    ),
    "utf8",
  );
}
