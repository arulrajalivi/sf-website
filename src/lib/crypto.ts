import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { requireEnv } from "./env";

/**
 * Authenticated encryption for integration tokens.
 *
 * Integration access/refresh tokens let this app act as the user inside Jira,
 * Linear and Notion, so a leaked database dump must not be a leaked set of
 * credentials. Every token is sealed with AES-256-GCM before it reaches a column
 * and opened only inside the server-side connect/refresh/push path.
 *
 * GCM (not CBC) because the auth tag makes tampering a decryption failure rather
 * than a silently corrupted token: a row edited in the database throws here
 * instead of producing garbage that a provider rejects with a confusing 401.
 *
 * Blob layout — `iv.tag.ciphertext`, each part base64:
 *   - a fresh 12-byte IV per call (GCM's nonce; reusing one across messages
 *     under the same key breaks the cipher outright), and
 *   - the 16-byte auth tag, verified on every open.
 * Dot-joined because base64 never produces a dot, so the split is unambiguous.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
export const TOKEN_ENCRYPTION_KEY_ENV = "TOKEN_ENCRYPTION_KEY";

/** Thrown for every failure in this module so callers can branch on one type. */
export class TokenCryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenCryptoError";
  }
}

let cachedKey: { source: string; key: Buffer } | undefined;

/**
 * The key, decoded from base64 and length-checked.
 *
 * Read on use rather than at module load (the app's env rule), and cached by its
 * source string so a rotated key in a long-lived dev process is picked up rather
 * than pinned for the life of the process.
 */
function encryptionKey(): Buffer {
  const source = requireEnv(TOKEN_ENCRYPTION_KEY_ENV);
  if (cachedKey?.source === source) return cachedKey.key;

  const key = Buffer.from(source, "base64");
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(
      `${TOKEN_ENCRYPTION_KEY_ENV} must be ${KEY_BYTES} bytes encoded as base64 ` +
        `(\`openssl rand -base64 32\`); decoded ${key.length}.`,
    );
  }

  cachedKey = { source, key };
  return key;
}

/** Seals a token. The result is safe to store; the input never is. */
export function encryptToken(plaintext: string): string {
  if (plaintext.length === 0) {
    throw new TokenCryptoError("Refusing to encrypt an empty token.");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(".");
}

/**
 * Opens a sealed token, or throws.
 *
 * A malformed blob, a tampered ciphertext and a wrong key all land here as a
 * TokenCryptoError: the caller's only correct response to any of them is to
 * treat the integration as unusable and ask the user to reconnect.
 */
export function decryptToken(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 3) {
    throw new TokenCryptoError(
      `Malformed token blob: expected iv.tag.ciphertext, got ${parts.length} part(s).`,
    );
  }

  const [ivB64, tagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  if (iv.length !== IV_BYTES) {
    throw new TokenCryptoError(
      `Malformed token blob: IV is ${iv.length} bytes, expected ${IV_BYTES}.`,
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    // The message deliberately carries no ciphertext or key material.
    throw new TokenCryptoError(
      "Token failed authenticated decryption — wrong key or altered ciphertext.",
      { cause },
    );
  }
}

/** Encrypts an optional token, keeping "absent" distinct from "encrypted". */
export function encryptOptionalToken(
  plaintext: string | null | undefined,
): string | null {
  return plaintext ? encryptToken(plaintext) : null;
}
