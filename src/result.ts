import { GoogleError } from "./google";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

export const fail = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

export function describeError(e: unknown): string {
  if (!(e instanceof GoogleError)) return "Internal error while handling the request.";
  switch (e.kind) {
    case "auth":
      return (
        "Google rejected the API key (invalid, disabled, or its project has no billing). " +
        "gemini-nano-banana-2.1 has no free tier, so use a key from a billing-enabled project. " +
        `Google said: ${e.message}`
      );
    case "rate_limit":
      return `Google rate limit or quota exceeded (HTTP 429). Try again later. Google said: ${e.message}`;
    case "upstream":
      return `Google service error (HTTP ${e.status}). Google said: ${e.message}`;
    default:
      return `Google rejected the request (HTTP ${e.status}): ${e.message}`;
  }
}
