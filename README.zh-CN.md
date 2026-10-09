# nano-banana-mcp

[English](README.md) | 简体中文

一个远程 [MCP](https://modelcontextprotocol.io) 服务,封装 Google 的 Nano Banana 图像模型(`gemini-nano-banana-2.1`,Gemini Interactions API),用于生图和改图。它跑在 Cloudflare Workers 上,无状态,认证方式是自带 key(BYOK):每个用户在请求头里带自己的 Google AI Studio API key,服务端不保存任何东西。

## 特性

- **两个 tool**:`get_upload_image_url` 和 `generate_image`。
- **图片字节不进入模型上下文。** 输入图片由 agent 用一条一次性的 `curl` 命令直接上传到 Google 的 Files API;结果以短时下载地址的形式返回。全程没有 base64。
- **改图和接力**:最多 14 张参考图,`continue_from` 可以接着上一轮结果继续改,14 种宽高比,1K / 2K / 4K 输出,可选 Google 搜索。
- **BYOK**:服务端自己没有 Google key,费用和配额记在每个用户自己的 Google 项目上。
- **无状态**:不用 R2、KV、数据库或 Durable Object。
- 返回里带 token 用量和估算费用(`estimated_cost_usd`)。

## 工作原理

```
Agent                         MCP 服务 (Worker)                   Google
  │ get_upload_image_url ───────► │ 开可续传上传会话 ───────────────► │
  │ ◄── 一条 curl 命令 ────────── │ ◄── 一次性上传地址 ────────────── │
  │ 执行 curl:把图片字节直接 POST 给 Google ─────────────────────► │
  │ ◄───────────────── {"file": {"name": "files/xxx", ...}} ──────── │
  │ generate_image(file_ids, prompt) ► │ 校验文件,创建 interaction ──► │
  │ ◄── interaction_id, download_url, usage, ... ──                  │
  │ curl download_url ───────────► │ 取回 interaction,返回 JPEG ───► │
```

上传是 agent 直接传给 Google,服务端看不到上传的图片字节。下载地址里带着用服务端密钥加密后的用户 key(见[安全](#安全)),这样服务端不用存任何东西,也能去 Google 取图。

## 前提

- 一个 Cloudflare 账号和 Node.js(较新的 LTS 版本)。
- 一个来自已开通计费的项目的 Google AI Studio API key。Google 价格页显示 `gemini-nano-banana-2.1` 没有免费层。
- 一个支持远程(Streamable HTTP)服务器、并能配置自定义请求头的 MCP 客户端,以及能执行 `curl` 并访问外网的 agent。纯聊天客户端用不了。

## 部署

```bash
git clone https://github.com/crabkun/nano-banana-mcp.git
cd nano-banana-mcp
npm install

# 生成 32 字节随机密钥,存成 Worker secret。
# 不要沿用本地 .dev.vars 里的值。
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" \
  | npx wrangler secret put TOKEN_ENCRYPTION_KEY

npm run deploy
```

MCP 端点是 `https://<worker 名>.<你的子域>.workers.dev/mcp`。

### 自定义域名

在 `wrangler.jsonc` 里加 route 和 `PUBLIC_BASE_URL`:

```jsonc
{
  "routes": [{ "pattern": "mcp.example.com", "custom_domain": true }],
  "vars": {
    "DOWNLOAD_TTL_SECONDS": "1800",
    "PUBLIC_BASE_URL": "https://mcp.example.com"
  }
}
```

用自定义域名时**建议设 `PUBLIC_BASE_URL`**:服务端用它作为下载地址的前缀,并把接受的 `Host`/`Origin` 主机名限制成你的域名。不设的话,下载地址按请求自身的 origin 拼,同时适用 MCP SDK 的默认校验(它只自动放行 `localhost` 和 `workers.dev`)。域名所在的 zone 必须在你的 Cloudflare 账号下。

## 配置 MCP 客户端

每个请求都在请求头里带自己的 AI Studio key:`Authorization: Bearer <key>`(也接受 `x-goog-api-key: <key>`)。Devin CLI 的示例(`.devin/mcp_config.local.json`,会被 git 忽略):

```json
{
  "mcpServers": {
    "nano-banana": {
      "url": "https://<你的 worker 域名>/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer <你的 AI Studio key>" }
    }
  }
}
```

不要把 key 放进会提交的文件里。缺 key 或 key 格式不对时不会返回 HTTP 401(有些客户端会因此走 OAuth 登录流程):`initialize` 和 `tools/list` 照常可用,调用 tool 时返回 `isError` 结果,并说明该配什么请求头。

## Tools

### `get_upload_image_url`

在 Google Files API 上开一个可续传上传会话,返回一条现成的 `curl` 命令,里面带一次性的上传地址。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mime_type` | enum | 是 | `image/png`、`image/jpeg`、`image/webp`、`image/heic`、`image/heif` |

把命令里的 `<IMAGE_PATH>` 换成本地图片路径并执行。输出的 JSON 里有 `file.name`(例如 `files/abc123def456`),把这个字符串传给 `generate_image` 的 `file_ids`。这条命令只能用一次,每张图都要重新调用一次这个 tool。Google 会在 48 小时后删除上传的文件。

### `generate_image`

生成新图或编辑已有图片。同步等待,通常 15 到 60 秒。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | 是 | 要生成什么,或要改什么。改图时请明确说改哪里、保留哪里(没有蒙版参数)。 |
| `file_ids` | string[](最多 14) | 否 | 上传输出里的 `file.name`,例如 `files/abc123`。也接受不带前缀的 `abc123`。 |
| `continue_from` | string | 否 | 上一次调用返回的 `interaction_id`,用于接着改。可以和 `file_ids` 一起用。 |
| `aspect_ratio` | enum | 否 | `1:1` `2:3` `3:2` `3:4` `4:3` `4:5` `5:4` `9:16` `16:9` `21:9` `1:8` `8:1` `1:4` `4:1`。 |
| `image_size` | `1K` / `2K` / `4K` | 否 | 默认 `1K`。2K 约为 1K 的 1.5 倍价格,4K 约 3.4 倍。 |
| `use_google_search` | boolean | 否 | 让模型联网搜索实时或真实的信息。默认 `false`。 |

模型固定为 `gemini-nano-banana-2.1`、`thinking_level: high`,都不暴露。输出始终是 JPEG。

返回示例:

```json
{
  "interaction_id": "v1_...",
  "download_url": "https://<host>/dl/v1_...?exp=...&k=...",
  "notice": "...",
  "text": "模型附带的文字(有才返回)",
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

- `download_url` 默认 30 分钟有效(`DOWNLOAD_TTL_SECONDS`),用 `curl` 下载。第一次下载可能要等几秒到半分钟,因为 Google 返回的响应很大。
- `notice` 是给调用方 agent 的固定提示(下载到当前工作目录、输出相对路径、除非用户要求否则不要把图片读进上下文)。它是写死的中文字符串,即 [`src/generate.ts`](src/generate.ts) 里的 `DOWNLOAD_NOTICE`,可以按你的环境修改。
- `search_queries` 只在 `use_google_search` 为 `true` 时返回。
- `estimated_cost_usd` 是按可配置的价格算的估算值,不含搜索费,也不扣缓存折扣,以 Google 账单为准。一次典型的 1K 改图约 0.04 美元。

## 配置

| 名称 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | secret,**必填** | 无 | 32 字节随机数(base64),用来加密下载地址里的用户 key。 |
| `PUBLIC_BASE_URL` | var | 请求的 origin | Worker 的公开地址。用自定义域名时建议设。 |
| `DOWNLOAD_TTL_SECONDS` | var | `1800` | 下载地址有效期,限制在 60 到 86400 之间。 |
| `MAX_INPUT_IMAGE_BYTES` | var | 20 MiB | 单张输入图的大小上限。 |
| `GEMINI_BASE_URL` | var | `https://generativelanguage.googleapis.com` | Google API 的基地址。 |
| `PRICE_INPUT_PER_M` | var | `1.5` | 输入每百万 token 的美元价格(用于估算费用)。 |
| `PRICE_TEXT_OUTPUT_PER_M` | var | `7.5` | 文字和思考输出每百万 token 的美元价格。 |
| `PRICE_IMAGE_OUTPUT_PER_M` | var | `30` | 图片输出每百万 token 的美元价格。 |

## 安全

- **服务端在转发给 Google 的过程中能看到你的 API key 明文。** 请自己部署自己的实例,或者让用到你实例的人知道这一点。建议给这个服务单独建一个 key,不用时删除。
- key 不保存、不写日志。下载地址里是它的加密形式:`token = base64url(iv || AES-256-GCM(TOKEN_ENCRYPTION_KEY, key))`,附加认证数据为 `"dl|" + interaction_id + "|" + exp`,所以改动地址里的 id 或过期时间都会导致解密失败。拿到地址的人能在有效期内下载这一张图,但拿不到 key。
- 如果 `TOKEN_ENCRYPTION_KEY` 泄露,所有已发出的地址里的 key 都能被解密,而地址会出现在 agent 的上下文和聊天记录里。密钥只放在 Worker secret 里,有疑虑就轮换;轮换后旧地址全部失效。
- 每个请求新建一个 `McpServer`,key 只存在于该请求的闭包里。不要引入全局 server、transport 或按 key 的缓存。
- 上传命令由服务端拼接后会被 agent 在 shell 里执行,所以拼接前会校验上传地址(https、预期的主机、受限的字符集)。
- Google 不校验上传内容,所以输入文件在使用前会用 `GET files/{id}` 检查状态、MIME 类型和大小。

## 已知限制

- 输出只有 JPEG。Google 文档里有 `response_format.delivery: "uri"`,但实测所有图像模型都返回 400,所以下载才走这个代理。
- **Cloudflare Workers 免费版的 CPU 上限是 10 ms。** `generate_image` 和下载都要解析 1.6 到 5 MB 的 JSON 响应。在已部署的 Worker 上跑过一轮完整链路,没有出现 CPU 超限错误,但没有测到实际的 CPU 时间。如果遇到报错,请用付费版,或改成流式提取。
- 如果 Google 返回 `400 User location is not supported for the API use`,说明 Worker 跑在了不被支持的地区。有一次测试里固定 placement 后好了:在 `wrangler.jsonc` 里加 `"placement": { "region": "gcp:us-east4" }`。这只是一次样本,不是保证。
- 不被支持的宽高比不会报错,而是被无声忽略。极端比例(`1:8`、`8:1`、`1:4`、`4:1`)文生图可用,带输入图编辑时不可靠。
- 每多一轮 `continue_from`,输入 token 都会增加(历史和图片会被重新计入输入),费用也随之增加。
- 未验证:不同 API key 之间的隔离(用 B 的 key 引用 A 的 `file_id` 或 `interaction_id`)、免费项目的 key 会报什么错、HEIC/HEIF 输入、超过 8 MB 的上传、被安全策略拦截时没有图片的响应形态。

## 开发

```bash
npm install
npm test            # 单元测试(Google 的响应是模拟数据)
npm run typecheck   # wrangler types + tsc
npm run dev         # 本地 wrangler dev,需要 .dev.vars
```

`.dev.vars` 已被 git 忽略,里面只放一个本地用的密钥:

```
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32 的输出>
```

对本地服务做冒烟测试(响应是 SSE,取 `data:` 那行):

```bash
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_upload_image_url","arguments":{"mime_type":"image/jpeg"}}}'
```

每次真实的 `generate_image` 调用都会按你用的 key 计费。

源码目录:

| 路径 | 作用 |
|---|---|
| `src/index.ts` | Worker 入口:`/mcp`、`/dl/*`、`/` |
| `src/server.ts` | 每个请求新建 `McpServer`;tool 描述 |
| `src/upload.ts`、`src/generate.ts` | 两个 tool |
| `src/download.ts`、`src/token.ts` | 下载路由和下载地址的 token 加密 |
| `src/google.ts`、`src/interaction.ts` | Google API 客户端;响应解析、用量和费用 |
| `src/auth.ts`、`src/ids.ts`、`src/curl.ts`、`src/env.ts`、`src/result.ts` | key 提取、id 校验、上传命令拼接、配置、tool 返回值 |

## 许可证

[MIT](LICENSE)
