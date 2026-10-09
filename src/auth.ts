const KEY_RE = /^[A-Za-z0-9._-]{16,256}$/;

export const MISSING_KEY_MESSAGE =
  "Missing or invalid API key. Configure your MCP client to send the header " +
  "`Authorization: Bearer <your Google AI Studio API key>` with every request.";

export function extractApiKey(headers: Headers): string | null {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  return bearer ?? headers.get("x-goog-api-key")?.trim() ?? null;
}

export function isValidApiKey(key: string | null): key is string {
  return key !== null && KEY_RE.test(key);
}
