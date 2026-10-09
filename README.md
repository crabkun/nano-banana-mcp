# nano-banana-mcp

English | [简体中文](README.zh-CN.md)

A remote [MCP](https://modelcontextprotocol.io) server that wraps Google's Nano Banana image model (`gemini-nano-banana-2.1`, Gemini Interactions API) for image generation and editing. It runs on Cloudflare Workers, is stateless, and uses bring-your-own-key (BYOK) authentication: every user sends their own Google AI Studio API key, and the server stores nothing.

## Features

- **Two tools**: `get_upload_image_url` and `generate_image`.
- **Image bytes never enter the model context.** Input images are uploaded to Google's Files API by the agent itself with a one-time `curl` command; results come back as a short-lived download URL. No base64 anywhere.
- **Edit and iterate**: up to 14 reference images, `continue_from` to keep refining a previous result, 14 aspect ratios, 1K / 2K / 4K output, optional Google Search grounding.
- **BYOK**: the server has no Google key of its own. Cost and quota are charged to each user's own Google project.
- **Stateless**: no R2, KV, database or Durable Objects.
- Responses include token usage and an estimated cost (`estimated_cost_usd`).

## How it works

```
Agent                         MCP server (Worker)                 Google
  │ get_upload_image_url ───────► │ open resumable upload session ──► │
  │ ◄── one curl command ──────── │ ◄── one-time upload URL ───────── │
  │ run curl: POST image bytes straight to Google ──────────────────► │
  │ ◄───────────────── {"file": {"name": "files/xxx", ...}} ───────── │
  │ generate_image(file_ids, prompt) ► │ validate files, create interaction ► │
  │ ◄── interaction_id, download_url, usage, ... ──                   │
  │ curl download_url ───────────► │ fetch interaction, return JPEG ─► │
```

The upload goes directly from the agent to Google, so the server never sees image bytes on the way in. The download URL carries the user's API key encrypted with AES-256-GCM (see [Security](#security)), which is how the server can fetch the image from Google without storing anything.

## Requirements

- A Cloudflare account and Node.js (a recent LTS release).
- A Google AI Studio API key from a project with billing enabled. Google's pricing page lists no free tier for `gemini-nano-banana-2.1`.
- An MCP client that supports remote (Streamable HTTP) servers with custom request headers, and an agent that can run `curl` and reach the internet. A pure chat client cannot use this server.

## Deploy

```bash
git clone https://github.com/crabkun/nano-banana-mcp.git
cd nano-banana-mcp
npm install

# Generate a random 32-byte secret and store it as a Worker secret.
# Do not reuse the value from a local .dev.vars file.
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" \
  | npx wrangler secret put TOKEN_ENCRYPTION_KEY

npm run deploy
```

The MCP endpoint is `https://<worker-name>.<your-subdomain>.workers.dev/mcp`.

### Custom domain

Add a route and `PUBLIC_BASE_URL` to `wrangler.jsonc`:

```jsonc
{
  "routes": [{ "pattern": "mcp.example.com", "custom_domain": true }],
  "vars": {
    "DOWNLOAD_TTL_SECONDS": "1800",
    "PUBLIC_BASE_URL": "https://mcp.example.com"
  }
}
```

`PUBLIC_BASE_URL` is recommended with a custom domain: the server uses it as the base of download URLs and to restrict the accepted `Host`/`Origin` hostnames to yours. If it is unset, download URLs are built from the request's own origin, and the MCP SDK's default checks apply (it only auto-allows `localhost` and `workers.dev`). The domain's zone must be on your Cloudflare account.

## Configure your MCP client

Send your own AI Studio key in a header on every request: `Authorization: Bearer <key>` (or `x-goog-api-key: <key>`). Example for Devin CLI (`.devin/mcp_config.local.json`, which is git-ignored):

```json
{
  "mcpServers": {
    "nano-banana": {
      "url": "https://<your-worker-host>/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer <your AI Studio key>" }
    }
  }
}
```

Keep the key out of anything you commit. Missing or malformed keys do not produce an HTTP 401 (which would trigger an OAuth flow in some clients): `initialize` and `tools/list` still work, and calling a tool returns an `isError` result that explains the header to send.

## Tools

### `get_upload_image_url`

Opens a resumable upload session on Google's Files API and returns a single ready-to-run `curl` command containing a one-time upload URL.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mime_type` | enum | yes | `image/png`, `image/jpeg`, `image/webp`, `image/heic`, `image/heif` |

Replace `<IMAGE_PATH>` in the command with the local image path and run it. The JSON it prints contains `file.name` (for example `files/abc123def456`); pass that string to `generate_image` in `file_ids`. The command works exactly once, so call the tool again for each image. Google deletes uploaded files after 48 hours.

### `generate_image`

Generates a new image or edits existing ones. Synchronous; typically 15 to 60 seconds.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | What to generate, or what to change. For edits, say exactly what to change and what to keep (there is no mask parameter). |
| `file_ids` | string[] (max 14) | no | `file.name` values from the upload output, e.g. `files/abc123`. The bare `abc123` form is also accepted. |
| `continue_from` | string | no | `interaction_id` from a previous call, to keep refining that result. Can be combined with `file_ids`. |
| `aspect_ratio` | enum | no | `1:1` `2:3` `3:2` `3:4` `4:3` `4:5` `5:4` `9:16` `16:9` `21:9` `1:8` `8:1` `1:4` `4:1`. |
| `image_size` | `1K` / `2K` / `4K` | no | Default `1K`. 2K costs about 1.5x and 4K about 3.4x of 1K. |
| `use_google_search` | boolean | no | Let the model use Google Search for real-time or factual content. Default `false`. |

The model is fixed to `gemini-nano-banana-2.1` with `thinking_level: high`; neither is exposed. Output is always JPEG.

Example result:

```json
{
  "interaction_id": "v1_...",
  "download_url": "https://<host>/dl/v1_...?exp=...&k=...",
  "notice": "...",
  "text": "Optional text the model attached",
  "usage": {
    "input_tokens": 1134,
    "cached_tokens": 0,
    "output_tokens": 1695,
    "thought_tokens": 281,
    "image_output_tokens": 1120
  },
  "estimated_cost_usd": 0.0396
}
```

- `download_url` is valid for 30 minutes by default (`DOWNLOAD_TTL_SECONDS`). Fetch it with `curl`. The first download can take a few seconds to half a minute because Google returns a large response.
- `notice` is a fixed hint for the calling agent (download to the working directory, print the relative path, do not read the image into context unless asked). It is a hard-coded Chinese string, `DOWNLOAD_NOTICE` in [`src/generate.ts`](src/generate.ts); edit it to suit your setup.
- `search_queries` appears only when `use_google_search` is `true`.
- `estimated_cost_usd` is an estimate from configurable prices, does not include search charges and does not discount cached tokens. Trust Google's billing over it. A typical 1K edit costs around $0.04.

## Configuration

| Name | Kind | Default | Description |
|---|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | secret, **required** | none | 32 random bytes, base64. Encrypts the user key inside download URLs. |
| `PUBLIC_BASE_URL` | var | request origin | Public base URL of the Worker. Recommended for a custom domain. |
| `DOWNLOAD_TTL_SECONDS` | var | `1800` | Download URL lifetime, clamped to 60 to 86400. |
| `MAX_INPUT_IMAGE_BYTES` | var | 20 MiB | Maximum size of each input image. |
| `GEMINI_BASE_URL` | var | `https://generativelanguage.googleapis.com` | Google API base URL. |
| `PRICE_INPUT_PER_M` | var | `1.5` | USD per million input tokens (cost estimate). |
| `PRICE_TEXT_OUTPUT_PER_M` | var | `7.5` | USD per million text and thinking output tokens. |
| `PRICE_IMAGE_OUTPUT_PER_M` | var | `30` | USD per million image output tokens. |

## Security

- **The server sees your API key in plaintext** while forwarding it to Google. Run your own instance, or tell the people you give access to. Consider creating a dedicated key for this server and deleting it when unused.
- The key is never stored or logged. Download URLs contain it encrypted: `token = base64url(iv || AES-256-GCM(TOKEN_ENCRYPTION_KEY, key))`, with `"dl|" + interaction_id + "|" + exp` as additional authenticated data, so changing the id or expiry makes decryption fail. Anyone holding a URL can download that one image until it expires, but cannot recover the key.
- If `TOKEN_ENCRYPTION_KEY` leaks, the keys inside every URL ever issued can be decrypted, and URLs appear in agent contexts and chat logs. Keep it only as a Worker secret and rotate it if in doubt; rotating invalidates all existing URLs.
- A fresh `McpServer` is created for every request and the key lives only in that request's closure. Do not introduce global servers, transports or per-key caches.
- The upload command is assembled by the server and then executed by the agent in a shell, so the upload URL is validated (https, expected host, restricted character set) before it is put into the command.
- Input files are checked with `GET files/{id}` (state, MIME type, size) before use, because Google does not validate upload content.

## Known limitations

- Output is JPEG only. `response_format.delivery: "uri"` is documented by Google but returned 400 for every image model in testing, which is why downloads go through this proxy.
- **Cloudflare Workers Free has a 10 ms CPU limit.** `generate_image` and downloads parse a 1.6 to 5 MB JSON response. One end-to-end run on a deployed Worker completed without a CPU-limit error, but the actual CPU time was not measured. If you hit errors, use the Paid plan or switch to streaming extraction.
- If Google returns `400 User location is not supported for the API use`, the Worker ran in an unsupported region. Pinning placement helped in one test: `"placement": { "region": "gcp:us-east4" }` in `wrangler.jsonc`. This is a single sample, not a guarantee.
- Unsupported aspect ratios are silently ignored rather than rejected. Extreme ratios (`1:8`, `8:1`, `1:4`, `4:1`) work for text-to-image but are unreliable when editing an input image.
- Input tokens, and so cost, grow with every `continue_from` round, since the history (including images) is counted as input again.
- Not verified: isolation across API keys (using key B to reference key A's `file_id` or `interaction_id`), the error returned for a free-tier project, HEIC/HEIF input, uploads above 8 MB, and behavior when a safety filter returns no image.

## Development

```bash
npm install
npm test            # unit tests (Google responses are mocked)
npm run typecheck   # wrangler types + tsc
npm run dev         # local wrangler dev, needs .dev.vars
```

`.dev.vars` is git-ignored and should contain only a local secret:

```
TOKEN_ENCRYPTION_KEY=<output of: openssl rand -base64 32>
```

Quick smoke test against a local server (the response is SSE; read the `data:` line):

```bash
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_upload_image_url","arguments":{"mime_type":"image/jpeg"}}}'
```

Every real `generate_image` call is billed to the key you use.

Source layout:

| Path | Purpose |
|---|---|
| `src/index.ts` | Worker entry: `/mcp`, `/dl/*`, `/` |
| `src/server.ts` | Builds a new `McpServer` per request; tool descriptions |
| `src/upload.ts`, `src/generate.ts` | The two tools |
| `src/download.ts`, `src/token.ts` | Download route and URL token encryption |
| `src/google.ts`, `src/interaction.ts` | Google API client; response parsing, usage and cost |
| `src/auth.ts`, `src/ids.ts`, `src/curl.ts`, `src/env.ts`, `src/result.ts` | Key extraction, id validation, upload command assembly, config, tool results |

## License

[MIT](LICENSE)
