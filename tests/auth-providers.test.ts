import { describe, expect, it } from "vitest";

import {
  listProviderAvailability,
  resolveSocialProviders,
} from "@/lib/auth-providers";

const FULL_ENV = {
  AUTH_GOOGLE_ID: "google-id",
  AUTH_GOOGLE_SECRET: "google-secret",
  AUTH_MICROSOFT_ID: "microsoft-id",
  AUTH_MICROSOFT_SECRET: "microsoft-secret",
  AUTH_MICROSOFT_TENANT_ID: "tenant-guid",
  AUTH_GITHUB_ID: "github-id",
  AUTH_GITHUB_SECRET: "github-secret",
};

describe("resolveSocialProviders", () => {
  it("configures all three login providers from AUTH_* variables", () => {
    expect(resolveSocialProviders(FULL_ENV)).toEqual({
      google: { clientId: "google-id", clientSecret: "google-secret" },
      microsoft: {
        clientId: "microsoft-id",
        clientSecret: "microsoft-secret",
        tenantId: "tenant-guid",
      },
      github: { clientId: "github-id", clientSecret: "github-secret" },
    });
  });

  it("returns nothing when no credentials are present", () => {
    expect(resolveSocialProviders({})).toEqual({});
  });

  it("omits a provider whose secret is missing rather than half-configuring it", () => {
    const resolved = resolveSocialProviders({
      ...FULL_ENV,
      AUTH_GITHUB_SECRET: undefined,
    });
    expect(resolved.github).toBeUndefined();
    expect(resolved.google).toBeDefined();
  });

  it("defaults the Entra tenant to common when unset", () => {
    const resolved = resolveSocialProviders({
      AUTH_MICROSOFT_ID: "microsoft-id",
      AUTH_MICROSOFT_SECRET: "microsoft-secret",
    });
    expect(resolved.microsoft?.tenantId).toBe("common");
  });

  it("never leaks a credential value into a provider it does not belong to", () => {
    const resolved = resolveSocialProviders(FULL_ENV);
    expect(resolved.google?.clientSecret).toBe("google-secret");
    expect(resolved.github?.clientSecret).toBe("github-secret");
  });
});

describe("listProviderAvailability", () => {
  it("always lists all three providers so the sign-in page can explain gaps", () => {
    const availability = listProviderAvailability({});
    expect(availability.map((provider) => provider.id)).toEqual([
      "google",
      "microsoft",
      "github",
    ]);
    expect(availability.every((provider) => !provider.configured)).toBe(true);
  });

  it("flags exactly the providers that can complete a sign-in", () => {
    const availability = listProviderAvailability({
      AUTH_GOOGLE_ID: "google-id",
      AUTH_GOOGLE_SECRET: "google-secret",
    });
    expect(
      availability.filter((provider) => provider.configured).map((p) => p.id),
    ).toEqual(["google"]);
  });
});
