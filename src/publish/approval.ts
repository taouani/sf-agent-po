import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Publishing is two calls: a preview, which returns what will be written plus
 * an approval token, and the publish itself, which needs that token. The token
 * is an HMAC over the exact target and content, keyed with a secret that never
 * leaves the server, so a publish can only write what the user was shown. If
 * the content or the target changes in between, the token no longer matches
 * and a new preview is required.
 */
export function approvalToken(secret: Buffer, payload: unknown): string {
  return createHmac("sha256", secret).update(stableJson(payload)).digest("base64url").slice(0, 22);
}

export function checkApproval(secret: Buffer, payload: unknown, token: string): void {
  const expected = Buffer.from(approvalToken(secret, payload));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error(
      "The approval token does not match. The content or target changed since the preview, or the token came from another preview. " +
        "Run the preview again, show it to the user, and publish only after they approve.",
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
