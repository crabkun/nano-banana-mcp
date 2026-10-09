import { z } from "zod";
import type { Config } from "./env";
import { GoogleError, type GoogleClient, type GoogleFile } from "./google";
import { isInteractionId, normalizeFileId } from "./ids";
import { collectText, countSearchQueries, estimateCostUsd, findLastImage, summarizeUsage } from "./interaction";
import { describeError, fail, ok, type ToolResult } from "./result";
import { sealKey } from "./token";

export const MODEL = "gemini-nano-banana-2.1";
export const MAX_FILES = 14;
export const ASPECT_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:8", "8:1", "1:4", "4:1",
] as const;
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export const DOWNLOAD_NOTICE =
  "请用 curl 将 download_url 下载到当前工作目录,然后把图片的相对路径输出给用户。除非用户明确要求你查看或分析图片内容,否则不要把图片文件读入上下文。";

export const generateImageSchema = z.object({
  prompt: z.string().min(1).describe("What to generate, or what to change. For edits, say exactly what to change and what to keep."),
  file_ids: z
    .array(z.string())
    .max(MAX_FILES)
    .optional()
    .describe('Input images to edit or use as references: the file.name values (like "files/abc123") from the upload command output. Up to 14.'),
  continue_from: z
    .string()
    .optional()
    .describe("interaction_id returned by a previous generate_image call, to keep refining that result. Can be combined with file_ids."),
  aspect_ratio: z
    .enum(ASPECT_RATIOS)
    .optional()
    .describe("Output aspect ratio. If omitted, the output follows the input image's size, or is 1:1 without input images."),
  image_size: z.enum(IMAGE_SIZES).optional().describe("Output resolution. Default 1K. 2K costs about 1.5x and 4K about 3.4x of 1K."),
  use_google_search: z.boolean().optional().describe("Let the model use Google Search for real-time or factual information. Default false."),
});

export type GenerateImageArgs = z.infer<typeof generateImageSchema>;

export interface GenerateDeps {
  google: GoogleClient;
  config: Config;
  apiKey: string;
  origin: string;
  now?: () => number;
}

const fileProblem = (id: string, file: GoogleFile, maxBytes: number): string | null => {
  if (file.state !== "ACTIVE") return `${id} is not ready (state: ${file.state}).`;
  if (!file.mimeType?.startsWith("image/")) return `${id} is not an image (mime type: ${file.mimeType}).`;
  if (Number(file.sizeBytes) > maxBytes) return `${id} is too large (${file.sizeBytes} bytes, limit ${maxBytes}).`;
  return null;
};

async function loadFile(google: GoogleClient, id: string): Promise<GoogleFile | string> {
  try {
    return await google.getFile(id);
  } catch (e) {
    if (e instanceof GoogleError && (e.kind === "forbidden" || e.kind === "not_found")) {
      return `${id}: file not found, upload not finished, expired (uploads live 48 hours), or not accessible with this API key. Upload it again with get_upload_image_url.`;
    }
    throw e;
  }
}

export async function generateImage(args: GenerateImageArgs, deps: GenerateDeps): Promise<ToolResult> {
  const { google, config } = deps;
  if (!config.tokenSecret) return fail("Server misconfigured: TOKEN_ENCRYPTION_KEY is not set.");

  const fileIds = new Set<string>();
  const invalid: string[] = [];
  for (const raw of args.file_ids ?? []) {
    const id = normalizeFileId(raw);
    if (id) fileIds.add(id);
    else invalid.push(raw);
  }
  if (invalid.length) {
    return fail(`Invalid file_ids: ${invalid.map((s) => JSON.stringify(s)).join(", ")}. Use the file.name value from the upload output, like "files/abc123".`);
  }
  if (fileIds.size > MAX_FILES) return fail(`At most ${MAX_FILES} file_ids are allowed.`);
  if (args.continue_from !== undefined && !isInteractionId(args.continue_from)) {
    return fail("Invalid continue_from. Use the interaction_id returned by a previous generate_image call.");
  }

  try {
    const loaded = await Promise.all([...fileIds].map(async (id) => ({ id, file: await loadFile(google, id) })));
    const problems = loaded.flatMap(({ id, file }) =>
      typeof file === "string" ? [file] : [fileProblem(id, file, config.maxInputBytes)].filter((p): p is string => p !== null),
    );
    if (problems.length) return fail(problems.join("\n"));

    const files = loaded.map(({ file }) => file as GoogleFile);
    const body: Record<string, unknown> = {
      model: MODEL,
      input: files.length
        ? [{ type: "text", text: args.prompt }, ...files.map((f) => ({ type: "image", uri: f.uri, mime_type: f.mimeType }))]
        : args.prompt,
      response_format: {
        type: "image",
        mime_type: "image/jpeg",
        image_size: args.image_size ?? "1K",
        ...(args.aspect_ratio && { aspect_ratio: args.aspect_ratio }),
      },
      generation_config: { thinking_level: "high" },
    };
    if (args.continue_from) body.previous_interaction_id = args.continue_from;
    if (args.use_google_search) body.tools = [{ type: "google_search" }];

    const interaction = await google.createInteraction(body);
    const text = collectText(interaction);
    if (!interaction.id || !isInteractionId(interaction.id) || !findLastImage(interaction)) {
      return fail(`The model returned no image.${text ? ` Model said: ${text}` : ""}`);
    }

    const exp = Math.floor((deps.now?.() ?? Date.now()) / 1000) + config.ttlSeconds;
    const token = await sealKey(config.tokenSecret, deps.apiKey, interaction.id, exp);
    const usage = summarizeUsage(interaction.usage);
    return ok({
      interaction_id: interaction.id,
      download_url: `${config.publicBaseUrl ?? deps.origin}/dl/${interaction.id}?exp=${exp}&k=${token}`,
      notice: DOWNLOAD_NOTICE,
      ...(text && { text }),
      usage,
      estimated_cost_usd: estimateCostUsd(usage, config.prices),
      ...(args.use_google_search && { search_queries: countSearchQueries(interaction) }),
    });
  } catch (e) {
    if (!(e instanceof GoogleError)) console.error("generate_image failed:", e instanceof Error ? e.message : e);
    return fail(describeError(e));
  }
}
