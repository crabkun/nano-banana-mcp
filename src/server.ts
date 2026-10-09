import { McpServer } from "@modelcontextprotocol/server";
import { MISSING_KEY_MESSAGE, isValidApiKey } from "./auth";
import type { Config } from "./env";
import { generateImage, generateImageSchema, MODEL } from "./generate";
import { GoogleClient } from "./google";
import { fail } from "./result";
import { getUploadImageUrl, uploadSchema } from "./upload";

export interface ServerOptions {
  apiKey: string | null;
  config: Config;
  origin: string;
}

const UPLOAD_DESCRIPTION = `Get a ready-to-run curl command that uploads one input image. Call this before generate_image whenever you need to edit an image or use it as a reference.

Replace <IMAGE_PATH> in the returned command with the local image path and run it. The command's JSON output contains file.name (for example "files/abc123"); pass that string as a file_id to generate_image.

The command works exactly once, so call this tool again for each image. Uploaded files are deleted after 48 hours. Never base64-encode an image into tool arguments.`;

const generateDescription = (ttlSeconds: number) => `Generate a new image or edit existing images with Nano Banana (${MODEL}).

Usage:
- Text-to-image: pass only \`prompt\`.
- Edit or reference existing images: upload each image first with get_upload_image_url, then pass the returned file ids (file.name, e.g. "files/abc123") in \`file_ids\` (up to 14).
- Keep refining a previous result: pass its interaction_id as \`continue_from\`. You may also pass new \`file_ids\` in the same call to add another reference image.

There is no mask parameter. To change only part of an image, say exactly what to change and what to keep, e.g. "change only the apple to gold, keep everything else exactly the same".

Returns interaction_id, a download_url (valid for ${Math.round(ttlSeconds / 60)} minutes; fetch it with curl), optional model text, token usage and an estimated cost. Output is always JPEG.

Generation is synchronous and typically takes 15-60 seconds. 2K costs about 1.5x and 4K about 3.4x of 1K, so keep the default 1K unless the user asks for higher resolution. When editing an existing image, avoid extreme aspect ratios (1:4, 4:1, 1:8, 8:1): the edit may fail or the model may redraw the subject. Set use_google_search only when the image needs real-time or factual information.`;

export function createServer({ apiKey, config, origin }: ServerOptions): McpServer {
  const server = new McpServer({ name: "nano-banana-mcp", version: "0.1.0" });
  const clientFor = () => (isValidApiKey(apiKey) ? new GoogleClient(apiKey, config.baseUrl) : null);

  server.registerTool(
    "get_upload_image_url",
    {
      title: "Get image upload command",
      description: UPLOAD_DESCRIPTION,
      inputSchema: uploadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const google = clientFor();
      return google ? getUploadImageUrl(args, { google, config }) : fail(MISSING_KEY_MESSAGE);
    },
  );

  server.registerTool(
    "generate_image",
    {
      title: "Generate or edit image",
      description: generateDescription(config.ttlSeconds),
      inputSchema: generateImageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const google = clientFor();
      return google && isValidApiKey(apiKey) ? generateImage(args, { google, config, apiKey, origin }) : fail(MISSING_KEY_MESSAGE);
    },
  );

  return server;
}
