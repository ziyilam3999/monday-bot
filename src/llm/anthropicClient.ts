import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// F6 mirror — macOS Keychain service name for Claude Code's OAuth blob.
// Mirrors forge-harness anthropic.ts (v0.40.5). If Claude Code renames the
// entry in a future release, this constant must follow.
export const KEYCHAIN_SERVICE_NAME = "Claude Code-credentials";

let client: Anthropic | null = null;
let clientExpiresAt: number | null = null;
let warnedOnceForMalformedCreds = false;

// F6 mirror — macOS Keychain fallback for the OAuth blob. On macOS, Claude
// Code stores credentials in Keychain rather than on disk after `/login`. When
// the file read fails AND we are on darwin, shell out to /usr/bin/security to
// fetch the blob. Returns the raw JSON-encoded blob (same shape as the file
// would have had) or null on any failure (non-darwin, missing entry, timeout).
function readOAuthTokenFromKeychain(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const username = userInfo().username;
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE_NAME, "-a", username, "-w"],
      { encoding: "utf-8", timeout: 2000 },
    ).trim();
  } catch {
    return null;
  }
}

function readOAuthToken(): { accessToken: string; expiresAt: number } | null {
  const credPath = join(homedir(), ".claude", ".credentials.json");
  let raw: string | null;
  try {
    raw = readFileSync(credPath, "utf-8");
  } catch {
    raw = readOAuthTokenFromKeychain();
  }
  if (raw === null || raw === "") return null;
  let creds: unknown;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    if (!warnedOnceForMalformedCreds) {
      warnedOnceForMalformedCreds = true;
      console.warn(
        `[anthropicClient] Malformed JSON credentials — falling back to ANTHROPIC_API_KEY: ${(err as Error).message}`,
      );
    }
    return null;
  }
  const oauth = (creds as { claudeAiOauth?: unknown }).claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown }
    | undefined;
  if (
    typeof oauth?.accessToken !== "string" ||
    typeof oauth?.expiresAt !== "number"
  ) {
    return null;
  }
  const remainingMs = oauth.expiresAt - Date.now();
  if (remainingMs < EXPIRY_BUFFER_MS) return null;
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
}

/**
 * #3136 fix-cycle RULE - no model call may present a reply cut at its output
 * cap as complete. Every call site that sets `max_tokens` calls this with its
 * OWN name after the reply lands; a `max_tokens` stop logs one warning line
 * naming that site. Reads only `stop_reason` and the site name (never the
 * reply text, never credentials), O(1).
 */
export function warnMaxTokensStop(
  response: { stop_reason?: string | null },
  callSite: string,
): void {
  if (response?.stop_reason === "max_tokens") {
    console.warn(
      `[${callSite}] model reply stopped at max_tokens - the text may be TRUNCATED; do not treat it as a complete answer`,
    );
  }
}

export function resetClient(): void {
  client = null;
  clientExpiresAt = null;
}

export function getClient(): Anthropic {
  if (
    client &&
    clientExpiresAt !== null &&
    Date.now() >= clientExpiresAt - EXPIRY_BUFFER_MS
  ) {
    client = null;
    clientExpiresAt = null;
  }
  if (client) return client;

  const oauthCreds = readOAuthToken();
  if (oauthCreds) {
    client = new Anthropic({ authToken: oauthCreds.accessToken });
    clientExpiresAt = oauthCreds.expiresAt;
    return client;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    client = new Anthropic({ apiKey });
    clientExpiresAt = null;
    return client;
  }

  throw new Error(
    "No Anthropic credentials found: OAuth token missing/expired at ~/.claude/.credentials.json or macOS Keychain (entry 'Claude Code-credentials') AND ANTHROPIC_API_KEY not set in environment.",
  );
}
