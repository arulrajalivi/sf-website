import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The Integration model is the storage contract for every connector: a rename or
 * a dropped constraint here breaks connect/disconnect at runtime, not at compile
 * time, and a missing migration breaks it only in a deployed environment. Both
 * are asserted from the files that actually ship.
 */

const schema = readFileSync(
  fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
  "utf8",
);

const migrationSql = readFileSync(
  fileURLToPath(
    new URL(
      "../prisma/migrations/20260827180000_integration/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

function modelBody(model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${model} is missing from schema.prisma`);
  return match[1];
}

const INTEGRATION_FIELDS = [
  "id",
  "provider",
  "status",
  "accountLabel",
  "workspaceRef",
  "accessTokenEnc",
  "refreshTokenEnc",
  "expiresAt",
  "scope",
  "lastRefreshedAt",
  "userId",
] as const;

describe("prisma schema — Integration contract", () => {
  it.each(INTEGRATION_FIELDS)("declares the %s field", (field) => {
    expect(modelBody("Integration")).toMatch(new RegExp(`^\\s*${field}\\s`, "m"));
  });

  it("allows one integration per user per provider", () => {
    expect(modelBody("Integration")).toContain("@@unique([userId, provider])");
  });

  it("cascades integrations when the owning user is deleted", () => {
    expect(modelBody("Integration")).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it("defaults a freshly created row to DISCONNECTED", () => {
    expect(modelBody("Integration")).toMatch(
      /status\s+IntegrationStatus\s+@default\(DISCONNECTED\)/,
    );
  });

  it("names every token column with the Enc suffix", () => {
    const tokenFields = [...modelBody("Integration").matchAll(/^\s*(\w*[Tt]oken\w*)\s/gm)].map(
      (match) => match[1],
    );
    expect(tokenFields.length).toBeGreaterThan(0);
    for (const field of tokenFields) {
      expect(field, `${field} must end in Enc — the column never holds plaintext`).toMatch(
        /Enc$/,
      );
    }
  });

  it.each([
    ["Provider", ["JIRA", "LINEAR", "NOTION"]],
    ["IntegrationStatus", ["CONNECTED", "EXPIRED", "DISCONNECTED"]],
  ] as const)("declares the %s enum with the spec's members", (name, members) => {
    const body = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
    expect(body, `enum ${name} is missing`).toBeDefined();
    for (const member of members) {
      expect(body).toMatch(new RegExp(`^\\s*${member}\\s*$`, "m"));
    }
  });
});

describe("prisma migrations — integration", () => {
  it("creates the table the model maps to", () => {
    const table = modelBody("Integration").match(/@@map\("([^"]+)"\)/)?.[1];
    expect(table).toBe("integration");
    expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
  });

  it.each(["Provider", "IntegrationStatus"])("creates the %s enum type", (name) => {
    expect(migrationSql).toContain(`CREATE TYPE "${name}"`);
  });

  it("enforces the per-user-per-provider uniqueness in SQL", () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "integration_userId_provider_key" ON "integration"\("userId", "provider"\)/,
    );
  });
});
