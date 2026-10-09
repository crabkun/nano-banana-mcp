import { z } from "zod";
import type { Config } from "./env";
import { buildUploadCommand } from "./curl";
import type { GoogleClient } from "./google";
import { describeError, fail, type ToolResult } from "./result";

export const MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"] as const;

export const uploadSchema = z.object({
  mime_type: z.enum(MIME_TYPES).describe("MIME type of the image you are about to upload."),
});

export type UploadArgs = z.infer<typeof uploadSchema>;

export async function getUploadImageUrl(args: UploadArgs, deps: { google: GoogleClient; config: Config }): Promise<ToolResult> {
  try {
    const uploadUrl = await deps.google.startUpload(args.mime_type);
    const command = buildUploadCommand(uploadUrl, new URL(deps.config.baseUrl).host);
    if (!command) return fail("Google did not return a usable upload URL. Try again.");
    return { content: [{ type: "text", text: command }] };
  } catch (e) {
    return fail(describeError(e));
  }
}
