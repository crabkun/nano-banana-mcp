import { loadConfig } from "../src/env";

export const API_KEY = "test-key-0123456789abcdef";
export const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const BASE = "https://generativelanguage.googleapis.com";
export const INTERACTION_ID = "v1_abcdefgh12345678";

export const config = loadConfig({ TOKEN_ENCRYPTION_KEY: SECRET });

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const googleError = (status: number, message: string) => json({ error: { code: status, message } }, status);

export function mockFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchFn, calls };
}

export const usageSample = {
  total_input_tokens: 1149,
  total_cached_tokens: 254,
  total_output_tokens: 2223,
  total_thought_tokens: 633,
  output_tokens_by_modality: [{ modality: "image", tokens: 1120 }],
};

export const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

export const interactionFixture = (overrides: Record<string, unknown> = {}) => ({
  id: INTERACTION_ID,
  status: "completed",
  steps: [
    { type: "thought", signature: "sig-1" },
    { type: "model_output", content: [{ type: "text", text: "Here you go" }] },
    { type: "thought", signature: "sig-2" },
    { type: "model_output", content: [{ type: "image", data: btoa(String.fromCharCode(...imageBytes)), mime_type: "image/jpeg" }] },
  ],
  usage: usageSample,
  ...overrides,
});

export const fileFixture = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  mimeType: "image/jpeg",
  sizeBytes: "300492",
  state: "ACTIVE",
  uri: `${BASE}/v1beta/${name}`,
  ...overrides,
});
