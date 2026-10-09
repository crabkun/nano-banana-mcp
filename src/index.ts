import { createMcpHandler } from "agents/mcp/server";
import { extractApiKey } from "./auth";
import { handleDownload } from "./download";
import { loadConfig, type Env } from "./env";
import { createServer } from "./server";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const config = loadConfig(env);

    if (url.pathname.startsWith("/dl/")) return handleDownload(request, { config });

    if (url.pathname === "/mcp") {
      const apiKey = extractApiKey(request.headers);
      const options = config.publicBaseUrl ? { allowedHostnames: [new URL(config.publicBaseUrl).hostname] } : undefined;
      return createMcpHandler(() => createServer({ apiKey, config, origin: url.origin }), options)(request, env, ctx);
    }

    if (url.pathname === "/") return new Response("nano-banana-mcp\n");
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
