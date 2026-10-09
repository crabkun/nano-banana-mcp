import { describe, expect, it } from "vitest";
import { extractApiKey, isValidApiKey } from "../src/auth";
import { buildUploadCommand } from "../src/curl";
import { isInteractionId, normalizeFileId } from "../src/ids";
import { collectText, countSearchQueries, decodeBase64, estimateCostUsd, findLastImage, summarizeUsage } from "../src/interaction";
import { openKey, sealKey } from "../src/token";
import { API_KEY, INTERACTION_ID, SECRET, config, imageBytes, interactionFixture, usageSample } from "./helpers";

describe("auth", () => {
  it("reads a Bearer token", () => {
    expect(extractApiKey(new Headers({ authorization: `Bearer ${API_KEY}` }))).toBe(API_KEY);
    expect(extractApiKey(new Headers({ authorization: `bearer ${API_KEY}  ` }))).toBe(API_KEY);
  });

  it("falls back to x-goog-api-key and prefers Authorization", () => {
    expect(extractApiKey(new Headers({ "x-goog-api-key": API_KEY }))).toBe(API_KEY);
    const both = new Headers({ authorization: "Bearer from-authorization-header", "x-goog-api-key": "from-google-header-xx" });
    expect(extractApiKey(both)).toBe("from-authorization-header");
  });

  it("returns null without a key", () => {
    expect(extractApiKey(new Headers())).toBeNull();
    expect(extractApiKey(new Headers({ authorization: "Basic abc" }))).toBeNull();
  });

  it("validates key format", () => {
    expect(isValidApiKey(API_KEY)).toBe(true);
    expect(isValidApiKey("AQ.fake_example-key.value1234567890")).toBe(true);
    expect(isValidApiKey(null)).toBe(false);
    expect(isValidApiKey("short")).toBe(false);
    expect(isValidApiKey("has space in the key 1234567890")).toBe(false);
    expect(isValidApiKey("x".repeat(257))).toBe(false);
  });
});

describe("ids", () => {
  it("normalizes file ids", () => {
    expect(normalizeFileId("files/abc123")).toBe("files/abc123");
    expect(normalizeFileId("abc123")).toBe("files/abc123");
    expect(normalizeFileId(" files/abc123def456 ")).toBe("files/abc123def456");
  });

  it("rejects malformed file ids", () => {
    for (const bad of ["", "files/", "files/ABC", "../files/abc", "files/abc/def", "https://x/v1beta/files/abc", "a b", "files/a;b"]) {
      expect(normalizeFileId(bad), bad).toBeNull();
    }
  });

  it("validates interaction ids", () => {
    expect(isInteractionId(INTERACTION_ID)).toBe(true);
    expect(isInteractionId("v1_ChdlNmJJYXNUcUlPR3Vuc0VQbDdEcDhRaxIXcWFmSWF1UzdETnJpN004UDl1LU9vUVk")).toBe(true);
    expect(isInteractionId("../x")).toBe(false);
    expect(isInteractionId("short")).toBe(false);
    expect(isInteractionId("a/b/c/d/e/f/g/h")).toBe(false);
  });
});

describe("buildUploadCommand", () => {
  const host = "generativelanguage.googleapis.com";
  const good = `https://${host}/upload/v1beta/files?upload_id=AP6rU83h_dhPEc-XzL4&upload_protocol=resumable`;

  it("builds the curl command", () => {
    expect(buildUploadCommand(good, host)).toBe(
      `curl -sS '${good}' -H 'X-Goog-Upload-Offset: 0' -H 'X-Goog-Upload-Command: upload, finalize' --data-binary @<IMAGE_PATH>`,
    );
  });

  it("rejects unsafe or foreign urls", () => {
    expect(buildUploadCommand(null, host)).toBeNull();
    expect(buildUploadCommand(`http://${host}/upload?x=1`, host)).toBeNull();
    expect(buildUploadCommand(`https://evil.example.com/upload?x=1`, host)).toBeNull();
    expect(buildUploadCommand(`${good}'; rm -rf ~; '`, host)).toBeNull();
    expect(buildUploadCommand(`${good}$(whoami)`, host)).toBeNull();
    expect(buildUploadCommand(`${good}\`id\``, host)).toBeNull();
    expect(buildUploadCommand(`${good} --output /etc/passwd`, host)).toBeNull();
    expect(buildUploadCommand(`${good};ls`, host)).toBeNull();
  });
});

describe("download token", () => {
  const exp = 1_900_000_000;

  it("round-trips the api key", async () => {
    const token = await sealKey(SECRET, API_KEY, INTERACTION_ID, exp);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(API_KEY);
    expect(await openKey(SECRET, token, INTERACTION_ID, exp)).toBe(API_KEY);
  });

  it("uses a fresh iv every time", async () => {
    expect(await sealKey(SECRET, API_KEY, INTERACTION_ID, exp)).not.toBe(await sealKey(SECRET, API_KEY, INTERACTION_ID, exp));
  });

  it("rejects tampering and wrong secrets", async () => {
    const token = await sealKey(SECRET, API_KEY, INTERACTION_ID, exp);
    expect(await openKey(SECRET, token, "v1_otherinteraction99", exp)).toBeNull();
    expect(await openKey(SECRET, token, INTERACTION_ID, exp + 1)).toBeNull();
    const otherSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    expect(await openKey(otherSecret, token, INTERACTION_ID, exp)).toBeNull();
    const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(await openKey(SECRET, flipped, INTERACTION_ID, exp)).toBeNull();
    expect(await openKey(SECRET, "", INTERACTION_ID, exp)).toBeNull();
    expect(await openKey(SECRET, "not base64url!!", INTERACTION_ID, exp)).toBeNull();
  });

  it("is short enough for a url", async () => {
    const token = await sealKey(SECRET, "AQ." + "x".repeat(50), INTERACTION_ID, exp);
    expect(token.length).toBeLessThan(130);
  });

  it("rejects a secret of the wrong size", async () => {
    await expect(sealKey(btoa("too short"), API_KEY, INTERACTION_ID, exp)).rejects.toThrow(/32/);
  });
});

describe("interaction parsing", () => {
  it("summarizes usage from a real response shape", () => {
    expect(summarizeUsage(usageSample)).toEqual({
      input_tokens: 1149,
      cached_tokens: 254,
      output_tokens: 2223,
      thought_tokens: 633,
      image_output_tokens: 1120,
    });
  });

  it("handles missing usage", () => {
    expect(summarizeUsage(undefined)).toEqual({ input_tokens: 0, cached_tokens: 0, output_tokens: 0, thought_tokens: 0, image_output_tokens: 0 });
  });

  it("estimates cost as input + image + remaining output", () => {
    expect(estimateCostUsd(summarizeUsage(usageSample), config.prices)).toBe(0.0436);
    expect(estimateCostUsd(summarizeUsage(undefined), config.prices)).toBe(0);
  });

  it("extracts text, the last image and search count", () => {
    const d = interactionFixture({
      steps: [
        { type: "model_output", content: [{ type: "text", text: "first" }] },
        { type: "model_output", content: [{ type: "image", data: "AAAA", mime_type: "image/jpeg" }] },
        { type: "model_output", content: [{ type: "text", text: "second" }, { type: "image", data: "QkJCQg==", mime_type: "image/png" }] },
        { type: "google_search_call" },
        { type: "google_search_call" },
        { type: "google_search_result" },
      ],
    });
    expect(collectText(d)).toBe("first\nsecond");
    expect(findLastImage(d)).toEqual({ data: "QkJCQg==", mimeType: "image/png" });
    expect(countSearchQueries(d)).toBe(2);
  });

  it("returns null when there is no image", () => {
    expect(findLastImage({ steps: [{ type: "model_output", content: [{ type: "text", text: "blocked" }] }] })).toBeNull();
    expect(findLastImage({})).toBeNull();
  });

  it("decodes base64 to the original bytes", () => {
    const encoded = btoa(String.fromCharCode(...imageBytes));
    expect([...decodeBase64(encoded)]).toEqual([...imageBytes]);
  });
});
