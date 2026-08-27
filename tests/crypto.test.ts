import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TOKEN_ENCRYPTION_KEY_ENV,
  TokenCryptoError,
  decryptToken,
  encryptOptionalToken,
  encryptToken,
} from "@/lib/crypto";

/**
 * These tests are the standing proof of the property the whole integration layer
 * rests on: what goes into the database cannot be read back without the key.
 */

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const TOKEN = "atlassian-access-token-9f3c1a";

let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env[TOKEN_ENCRYPTION_KEY_ENV];
  process.env[TOKEN_ENCRYPTION_KEY_ENV] = KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env[TOKEN_ENCRYPTION_KEY_ENV];
  else process.env[TOKEN_ENCRYPTION_KEY_ENV] = originalKey;
});

describe("encryptToken / decryptToken", () => {
  it("round-trips a token", () => {
    expect(decryptToken(encryptToken(TOKEN))).toBe(TOKEN);
  });

  it("round-trips unicode and long tokens", () => {
    const awkward = `${"x".repeat(4096)}·ключ·🔐`;
    expect(decryptToken(encryptToken(awkward))).toBe(awkward);
  });

  it("never leaves the plaintext visible in the blob", () => {
    const blob = encryptToken(TOKEN);
    expect(blob).not.toContain(TOKEN);
    expect(Buffer.from(blob, "utf8").toString("latin1")).not.toContain(TOKEN);
  });

  it("produces a different blob every time (fresh IV per call)", () => {
    const blobs = new Set(Array.from({ length: 16 }, () => encryptToken(TOKEN)));
    expect(blobs.size).toBe(16);
    for (const blob of blobs) expect(decryptToken(blob)).toBe(TOKEN);
  });

  it("emits iv.tag.ciphertext with a 12-byte IV and 16-byte tag", () => {
    const [iv, tag, ciphertext] = encryptToken(TOKEN).split(".");
    expect(Buffer.from(iv, "base64")).toHaveLength(12);
    expect(Buffer.from(tag, "base64")).toHaveLength(16);
    expect(Buffer.from(ciphertext, "base64").length).toBeGreaterThan(0);
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const [iv, tag, ciphertext] = encryptToken(TOKEN).split(".");
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptToken(`${iv}.${tag}.${bytes.toString("base64")}`)).toThrow(
      TokenCryptoError,
    );
  });

  it("rejects a swapped auth tag", () => {
    const [iv, , ciphertext] = encryptToken(TOKEN).split(".");
    const [, otherTag] = encryptToken("a different token").split(".");
    expect(() => decryptToken(`${iv}.${otherTag}.${ciphertext}`)).toThrow(
      TokenCryptoError,
    );
  });

  it("cannot be opened with a different key", () => {
    const blob = encryptToken(TOKEN);
    process.env[TOKEN_ENCRYPTION_KEY_ENV] = OTHER_KEY;
    expect(() => decryptToken(blob)).toThrow(TokenCryptoError);
  });

  it.each([
    ["not-a-blob", "expected iv.tag.ciphertext"],
    ["one.two", "expected iv.tag.ciphertext"],
    ["c2hvcnQ=.dGFn.Y2lwaGVy", "IV is"],
  ])("rejects the malformed blob %s", (blob, message) => {
    expect(() => decryptToken(blob)).toThrow(message);
  });

  it("refuses to encrypt an empty token", () => {
    expect(() => encryptToken("")).toThrow(TokenCryptoError);
  });
});

describe("key handling", () => {
  it("names the missing variable rather than failing obscurely", () => {
    delete process.env[TOKEN_ENCRYPTION_KEY_ENV];
    expect(() => encryptToken(TOKEN)).toThrow(TOKEN_ENCRYPTION_KEY_ENV);
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env[TOKEN_ENCRYPTION_KEY_ENV] = randomBytes(16).toString("base64");
    expect(() => encryptToken(TOKEN)).toThrow(/must be 32 bytes/);
  });

  it("picks up a rotated key rather than caching the first one", () => {
    const underFirstKey = encryptToken(TOKEN);
    process.env[TOKEN_ENCRYPTION_KEY_ENV] = OTHER_KEY;
    const underSecondKey = encryptToken(TOKEN);

    expect(decryptToken(underSecondKey)).toBe(TOKEN);
    expect(() => decryptToken(underFirstKey)).toThrow(TokenCryptoError);
  });
});

describe("encryptOptionalToken", () => {
  it("keeps absent tokens null instead of encrypting an empty string", () => {
    expect(encryptOptionalToken(null)).toBeNull();
    expect(encryptOptionalToken(undefined)).toBeNull();
    expect(encryptOptionalToken("")).toBeNull();
  });

  it("encrypts a present token", () => {
    const blob = encryptOptionalToken(TOKEN);
    expect(blob).not.toBeNull();
    expect(decryptToken(blob as string)).toBe(TOKEN);
  });
});
