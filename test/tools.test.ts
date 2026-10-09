import { describe, expect, it } from "vitest";
import { DOWNLOAD_NOTICE, generateImage } from "../src/generate";
import { GoogleClient } from "../src/google";
import { handleDownload } from "../src/download";
import { sealKey, openKey } from "../src/token";
import { getUploadImageUrl } from "../src/upload";
import {
  API_KEY, BASE, INTERACTION_ID, SECRET, config, fileFixture, googleError, imageBytes, interactionFixture, json, mockFetch,
} from "./helpers";

const NOW = 1_800_000_000_000;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

const client = (fetchFn: typeof fetch) => new GoogleClient(API_KEY, BASE, { fetchFn, retryDelayMs: 0 });
const run = (args: Parameters<typeof generateImage>[0], fetchFn: typeof fetch) =>
  generateImage(args, { google: client(fetchFn), config, apiKey: API_KEY, origin: "https://mcp.example.com", now: () => NOW });

describe("get_upload_image_url", () => {
  const uploadUrl = `${BASE}/upload/v1beta/files?upload_id=abc_DEF-123&upload_protocol=resumable`;

  it("starts a resumable session with the caller's key and returns a curl command", async () => {
    const { fetchFn, calls } = mockFetch(() => new Response("", { headers: { "x-goog-upload-url": uploadUrl } }));
    const result = await getUploadImageUrl({ mime_type: "image/png" }, { google: client(fetchFn), config });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain(`curl -sS '${uploadUrl}'`);
    expect(text(result)).toContain("@<IMAGE_PATH>");
    expect(text(result)).not.toContain(API_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/upload/v1beta/files`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe(API_KEY);
    expect(calls[0]!.headers.get("x-goog-upload-command")).toBe("start");
    expect(calls[0]!.headers.get("x-goog-upload-protocol")).toBe("resumable");
    expect(calls[0]!.headers.get("x-goog-upload-header-content-type")).toBe("image/png");
    expect(calls[0]!.body).toEqual({});
  });

  it("fails when Google returns no usable upload url", async () => {
    const { fetchFn } = mockFetch(() => new Response(""));
    expect((await getUploadImageUrl({ mime_type: "image/png" }, { google: client(fetchFn), config })).isError).toBe(true);
    const evil = mockFetch(() => new Response("", { headers: { "x-goog-upload-url": "https://evil.example.com/x?a=1" } }));
    expect((await getUploadImageUrl({ mime_type: "image/png" }, { google: client(evil.fetchFn), config })).isError).toBe(true);
  });

  it("explains key problems without echoing the key", async () => {
    const { fetchFn } = mockFetch(() => googleError(400, `API key not valid: ${API_KEY}`));
    const result = await getUploadImageUrl({ mime_type: "image/png" }, { google: client(fetchFn), config });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("billing-enabled");
    expect(text(result)).not.toContain(API_KEY);
  });
});

describe("generate_image", () => {
  it("text-to-image sends a string input and the fixed settings", async () => {
    const { fetchFn, calls } = mockFetch(() => json(interactionFixture()));
    const result = await run({ prompt: "a pixel apple" }, fetchFn);
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1beta/interactions`);
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe(API_KEY);
    expect(calls[0]!.body).toEqual({
      model: "gemini-nano-banana-2.1",
      input: "a pixel apple",
      response_format: { type: "image", mime_type: "image/jpeg", image_size: "1K" },
      generation_config: { thinking_level: "high" },
    });

    const out = JSON.parse(text(result));
    expect(out.interaction_id).toBe(INTERACTION_ID);
    expect(out.text).toBe("Here you go");
    expect(out.usage.image_output_tokens).toBe(1120);
    expect(out.estimated_cost_usd).toBe(0.0436);
    expect(out.notice).toBe(DOWNLOAD_NOTICE);
    expect(out).not.toHaveProperty("search_queries");
  });

  it("returns a download url that only the server can open", async () => {
    const { fetchFn } = mockFetch(() => json(interactionFixture()));
    const out = JSON.parse(text(await run({ prompt: "x" }, fetchFn)));
    const url = new URL(out.download_url);
    expect(url.origin).toBe("https://mcp.example.com");
    expect(url.pathname).toBe(`/dl/${INTERACTION_ID}`);
    const exp = Number(url.searchParams.get("exp"));
    expect(exp).toBe(NOW / 1000 + config.ttlSeconds);
    expect(out.download_url).not.toContain(API_KEY);
    expect(await openKey(SECRET, url.searchParams.get("k")!, INTERACTION_ID, exp)).toBe(API_KEY);
  });

  it("combines files, continue_from, aspect ratio, size and search", async () => {
    const { fetchFn, calls } = mockFetch((call) =>
      call.url.includes("/v1beta/files/")
        ? json(fileFixture(call.url.split("/v1beta/")[1]!))
        : json(interactionFixture({ steps: [...interactionFixture().steps, { type: "google_search_call" }] })),
    );
    const result = await run(
      { prompt: "put it in her hands", file_ids: ["files/aaa111", "bbb222", "files/aaa111"], continue_from: INTERACTION_ID, aspect_ratio: "16:9", image_size: "2K", use_google_search: true },
      fetchFn,
    );
    expect(result.isError).toBeUndefined();
    const fileCalls = calls.filter((c) => c.url.includes("/v1beta/files/"));
    expect(fileCalls.map((c) => c.url).sort()).toEqual([`${BASE}/v1beta/files/aaa111`, `${BASE}/v1beta/files/bbb222`]);
    const interactionBody = calls.find((c) => c.url.endsWith("/v1beta/interactions"))!.body;
    expect(interactionBody).toEqual({
      model: "gemini-nano-banana-2.1",
      previous_interaction_id: INTERACTION_ID,
      input: [
        { type: "text", text: "put it in her hands" },
        { type: "image", uri: `${BASE}/v1beta/files/aaa111`, mime_type: "image/jpeg" },
        { type: "image", uri: `${BASE}/v1beta/files/bbb222`, mime_type: "image/jpeg" },
      ],
      tools: [{ type: "google_search" }],
      response_format: { type: "image", mime_type: "image/jpeg", image_size: "2K", aspect_ratio: "16:9" },
      generation_config: { thinking_level: "high" },
    });
    expect(JSON.parse(text(result)).search_queries).toBe(1);
  });

  it("rejects malformed ids before calling Google", async () => {
    const { fetchFn, calls } = mockFetch(() => json({}));
    const badFile = await run({ prompt: "x", file_ids: ["files/ok1", "../etc"] }, fetchFn);
    expect(badFile.isError).toBe(true);
    expect(text(badFile)).toContain("../etc");
    const badContinue = await run({ prompt: "x", continue_from: "not/valid/../id" }, fetchFn);
    expect(badContinue.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("reports unavailable files and stops before generating", async () => {
    const { fetchFn, calls } = mockFetch(() => googleError(403, "Permission denied or file does not exist"));
    const result = await run({ prompt: "x", file_ids: ["files/gone1"] }, fetchFn);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("files/gone1");
    expect(text(result)).toMatch(/expired/);
    expect(calls.some((c) => c.url.endsWith("/v1beta/interactions"))).toBe(false);
  });

  it("rejects files that are not ready, not images, or too large", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ state: "PROCESSING" }, /not ready/],
      [{ mimeType: "text/plain" }, /not an image/],
      [{ sizeBytes: String(config.maxInputBytes + 1) }, /too large/],
    ];
    for (const [override, pattern] of cases) {
      const { fetchFn } = mockFetch(() => json(fileFixture("files/abc1", override)));
      const result = await run({ prompt: "x", file_ids: ["files/abc1"] }, fetchFn);
      expect(result.isError, JSON.stringify(override)).toBe(true);
      expect(text(result)).toMatch(pattern);
    }
  });

  it("fails with the model text when no image comes back", async () => {
    const { fetchFn } = mockFetch(() => json(interactionFixture({ steps: [{ type: "model_output", content: [{ type: "text", text: "I can't do that." }] }] })));
    const result = await run({ prompt: "x" }, fetchFn);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("I can't do that.");
  });

  it("retries once on 503 and then succeeds", async () => {
    const { fetchFn, calls } = mockFetch((_, i) => (i === 0 ? googleError(503, "overloaded") : json(interactionFixture())));
    expect((await run({ prompt: "x" }, fetchFn)).isError).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("does not retry other errors and never leaks the key", async () => {
    const { fetchFn, calls } = mockFetch(() => googleError(400, `bad request for key ${API_KEY}`));
    const result = await run({ prompt: "x" }, fetchFn);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(text(result)).not.toContain(API_KEY);
  });

  it("explains rate limits", async () => {
    const { fetchFn } = mockFetch(() => googleError(429, "quota exceeded"));
    const result = await run({ prompt: "x" }, fetchFn);
    expect(text(result)).toMatch(/rate limit or quota/);
  });
});

describe("download route", () => {
  const exp = NOW / 1000 + 600;
  const request = (path: string, method = "GET") => new Request(`https://mcp.example.com${path}`, { method });
  const link = async (id = INTERACTION_ID, e = exp, secret = SECRET) =>
    `/dl/${id}?exp=${e}&k=${await sealKey(secret, API_KEY, id, e)}`;
  const deps = (fetchFn: typeof fetch) => ({ config, fetchFn, now: () => NOW, retryDelayMs: 0 });

  it("returns the image bytes fetched with the key inside the token", async () => {
    const { fetchFn, calls } = mockFetch(() => json(interactionFixture()));
    const res = await handleDownload(request(await link()), deps(fetchFn));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...imageBytes]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1beta/interactions/${INTERACTION_ID}`);
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe(API_KEY);
  });

  it("rejects expired, tampered and foreign links without calling Google", async () => {
    const { fetchFn, calls } = mockFetch(() => json(interactionFixture()));
    const expired = await handleDownload(request(await link(INTERACTION_ID, NOW / 1000 - 1)), deps(fetchFn));
    expect(expired.status).toBe(410);

    const good = await link();
    const otherId = good.replace(INTERACTION_ID, "v1_zzzzzzzzzzzzzzzz");
    expect((await handleDownload(request(otherId), deps(fetchFn))).status).toBe(403);

    const otherExp = good.replace(`exp=${exp}`, `exp=${exp + 100}`);
    expect((await handleDownload(request(otherExp), deps(fetchFn))).status).toBe(403);

    const otherSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
    expect((await handleDownload(request(await link(INTERACTION_ID, exp, otherSecret)), deps(fetchFn))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("validates the request shape", async () => {
    const { fetchFn } = mockFetch(() => json(interactionFixture()));
    expect((await handleDownload(request(await link(), "POST"), deps(fetchFn))).status).toBe(405);
    expect((await handleDownload(request("/dl/x"), deps(fetchFn))).status).toBe(400);
    expect((await handleDownload(request(`/dl/${INTERACTION_ID}`), deps(fetchFn))).status).toBe(400);
    expect((await handleDownload(request(`/dl/${INTERACTION_ID}?exp=abc&k=zzz`), deps(fetchFn))).status).toBe(400);
    expect((await handleDownload(request(`/dl/a/b?exp=${exp}&k=zzz`), deps(fetchFn))).status).toBe(400);
  });

  it("maps Google failures", async () => {
    const notFound = mockFetch(() => googleError(403, "gone"));
    expect((await handleDownload(request(await link()), deps(notFound.fetchFn))).status).toBe(404);
    const upstream = mockFetch(() => googleError(500, "boom"));
    expect((await handleDownload(request(await link()), deps(upstream.fetchFn))).status).toBe(502);
    const noImage = mockFetch(() => json(interactionFixture({ steps: [] })));
    expect((await handleDownload(request(await link()), deps(noImage.fetchFn))).status).toBe(404);
  });
});
