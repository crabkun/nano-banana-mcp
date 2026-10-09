import type { Prices } from "./env";

export interface UsageSummary {
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  image_output_tokens: number;
}

interface Block {
  type?: string;
  text?: string;
  data?: string;
  mime_type?: string;
}

interface Step {
  type?: string;
  content?: Block[];
}

export interface RawInteraction {
  id?: string;
  steps?: Step[];
  usage?: Record<string, unknown>;
}

const toNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const outputBlocks = (d: RawInteraction): Block[] =>
  (d.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []);

export function collectText(d: RawInteraction): string {
  return outputBlocks(d)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function findLastImage(d: RawInteraction): { data: string; mimeType: string } | null {
  const image = outputBlocks(d)
    .filter((b) => b.type === "image" && b.data)
    .at(-1);
  return image?.data ? { data: image.data, mimeType: image.mime_type ?? "image/jpeg" } : null;
}

export function countSearchQueries(d: RawInteraction): number {
  return (d.steps ?? []).filter((s) => s.type === "google_search_call").length;
}

export function summarizeUsage(usage: RawInteraction["usage"]): UsageSummary {
  const byModality = Array.isArray(usage?.output_tokens_by_modality) ? usage.output_tokens_by_modality : [];
  const image = byModality
    .filter((m: { modality?: string }) => String(m?.modality).toLowerCase() === "image")
    .reduce((sum: number, m: { tokens?: number }) => sum + toNumber(m.tokens), 0);
  return {
    input_tokens: toNumber(usage?.total_input_tokens),
    cached_tokens: toNumber(usage?.total_cached_tokens),
    output_tokens: toNumber(usage?.total_output_tokens),
    thought_tokens: toNumber(usage?.total_thought_tokens),
    image_output_tokens: image,
  };
}

export function estimateCostUsd(u: UsageSummary, prices: Prices): number {
  const textOutput = Math.max(0, u.output_tokens - u.image_output_tokens);
  const usd =
    (u.input_tokens * prices.input + u.image_output_tokens * prices.imageOutput + textOutput * prices.textOutput) / 1e6;
  return Math.round(usd * 1e4) / 1e4;
}

export function decodeBase64(data: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (native) return native.call(Uint8Array, data);
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
