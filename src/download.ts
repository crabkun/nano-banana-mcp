import type { Config } from "./env";
import { GoogleClient, GoogleError } from "./google";
import { isInteractionId } from "./ids";
import { decodeBase64, findLastImage } from "./interaction";
import { openKey } from "./token";

export interface DownloadDeps {
  config: Config;
  fetchFn?: typeof fetch;
  now?: () => number;
  retryDelayMs?: number;
}

const message = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function handleDownload(request: Request, deps: DownloadDeps): Promise<Response> {
  if (request.method !== "GET") return message(405, "Method not allowed");
  const { config } = deps;
  const url = new URL(request.url);
  const id = url.pathname.match(/^\/dl\/([A-Za-z0-9_-]+)$/)?.[1];
  const expRaw = url.searchParams.get("exp");
  const token = url.searchParams.get("k");
  if (!id || !isInteractionId(id) || !expRaw || !/^\d{1,12}$/.test(expRaw) || !token) return message(400, "Invalid download link");

  const exp = Number(expRaw);
  if (exp < Math.floor((deps.now?.() ?? Date.now()) / 1000)) return message(410, "This download link has expired");

  const apiKey = await openKey(config.tokenSecret, token, id, exp);
  if (!apiKey) return message(403, "Invalid download link");

  const google = new GoogleClient(apiKey, config.baseUrl, { fetchFn: deps.fetchFn, retryDelayMs: deps.retryDelayMs });
  let image: ReturnType<typeof findLastImage>;
  try {
    image = findLastImage(await google.getInteraction(id));
  } catch (e) {
    if (e instanceof GoogleError && (e.kind === "forbidden" || e.kind === "not_found")) {
      return message(404, "Image not found or expired");
    }
    return message(502, "Could not fetch the image from Google");
  }
  if (!image) return message(404, "No image in this interaction");

  const extension = EXTENSIONS[image.mimeType] ?? "bin";
  return new Response(decodeBase64(image.data), {
    headers: {
      "content-type": image.mimeType,
      "content-disposition": `inline; filename="nano-banana-${id.slice(-8)}.${extension}"`,
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
