import { describe, expect, it } from "vitest";

import { SOCIAL_PROVIDER_IDS } from "@/lib/auth-providers";

import { PROVIDER_ICONS } from "@/app/sign-in/provider-buttons";

describe("PROVIDER_ICONS", () => {
  it("has a brand mark for every social provider", () => {
    expect(Object.keys(PROVIDER_ICONS).sort()).toEqual(
      [...SOCIAL_PROVIDER_IDS].sort(),
    );
  });

  it("renders each mark as an inline svg", () => {
    for (const icon of Object.values(PROVIDER_ICONS)) {
      expect(icon.type).toBe("svg");
    }
  });
});
