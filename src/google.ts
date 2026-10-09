import type { RawInteraction } from "./interaction";

export type GoogleErrorKind = "auth" | "forbidden" | "not_found" | "rate_limit" | "upstream" | "bad_request";

export class GoogleError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GoogleFile {
  name: string;
  mimeType: string;
  sizeBytes: string;
  state: string;
  uri: string;
}

export interface GoogleClientOptions {
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
}

const classify = (status: number, message: string): GoogleErrorKind => {
  if (status === 401 || (status === 400 && /api key/i.test(message))) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  return status >= 500 ? "upstream" : "bad_request";
};

export class GoogleClient {
  private readonly fetchFn: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    options: GoogleClientOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  private async toError(res: Response): Promise<GoogleError> {
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 500);
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {}
    message = message.split(this.apiKey).join("[redacted]");
    return new GoogleError(classify(res.status, message), res.status, message);
  }

  private async request(path: string, init: RequestInit = {}, canRetry = true): Promise<Response> {
    const res = await this.fetchFn(this.baseUrl + path, {
      ...init,
      headers: { "x-goog-api-key": this.apiKey, ...init.headers },
    });
    if (res.ok) return res;
    if (canRetry && (res.status === 429 || res.status === 503)) {
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      return this.request(path, init, false);
    }
    throw await this.toError(res);
  }

  async startUpload(mimeType: string): Promise<string | null> {
    const res = await this.request("/upload/v1beta/files", {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    await res.body?.cancel();
    return res.headers.get("x-goog-upload-url");
  }

  async getFile(name: string): Promise<GoogleFile> {
    return (await this.request(`/v1beta/${name}`)).json();
  }

  async createInteraction(body: unknown): Promise<RawInteraction> {
    const res = await this.request("/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async getInteraction(id: string): Promise<RawInteraction> {
    return (await this.request(`/v1beta/interactions/${id}`)).json();
  }
}
