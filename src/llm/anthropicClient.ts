import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let client: Anthropic | null = null;
let clientExpiresAt: number | null = null;
let warnedOnceForMalformedCreds = false;

function readOAuthToken(): { accessToken: string; expiresAt: number } | null {
  const credPath = join(homedir(), ".claude", ".credentials.json");
  let raw: string;
  try {
    raw = readFileSync(credPath, "utf-8");
  } catch {
    return null;
  }
  let creds: unknown;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    if (!warnedOnceForMalformedCreds) {
      warnedOnceForMalformedCreds = true;
      console.warn(
        `[anthropicClient] Malformed JSON at ${credPath} — falling back to ANTHROPIC_API_KEY: ${(err as Error).message}`,
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
    "No Anthropic credentials found: OAuth token missing/expired at ~/.claude/.credentials.json AND ANTHROPIC_API_KEY not set in environment.",
  );
}
