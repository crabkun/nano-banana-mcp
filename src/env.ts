export interface Env {
  TOKEN_ENCRYPTION_KEY: string;
  GEMINI_BASE_URL?: string;
  PUBLIC_BASE_URL?: string;
  DOWNLOAD_TTL_SECONDS?: string;
  MAX_INPUT_IMAGE_BYTES?: string;
  PRICE_INPUT_PER_M?: string;
  PRICE_TEXT_OUTPUT_PER_M?: string;
  PRICE_IMAGE_OUTPUT_PER_M?: string;
}

export interface Prices {
  input: number;
  textOutput: number;
  imageOutput: number;
}

export interface Config {
  baseUrl: string;
  publicBaseUrl?: string;
  tokenSecret: string;
  ttlSeconds: number;
  maxInputBytes: number;
  prices: Prices;
}

const num = (raw: string | undefined, fallback: number, min = 0) => {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

export function loadConfig(env: Env): Config {
  return {
    baseUrl: (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || undefined,
    tokenSecret: env.TOKEN_ENCRYPTION_KEY,
    ttlSeconds: Math.min(num(env.DOWNLOAD_TTL_SECONDS, 1800, 60), 86400),
    maxInputBytes: num(env.MAX_INPUT_IMAGE_BYTES, 20 * 1024 * 1024, 1),
    prices: {
      input: num(env.PRICE_INPUT_PER_M, 1.5),
      textOutput: num(env.PRICE_TEXT_OUTPUT_PER_M, 7.5),
      imageOutput: num(env.PRICE_IMAGE_OUTPUT_PER_M, 30),
    },
  };
}
