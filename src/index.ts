#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import express, { type Request, type Response as ExpressResponse } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { serverConfig, type ServerConfig } from "./config.js";

type ConversionMode = "video_to_mp3" | "video_to_word" | "mp3_to_word" | "word_to_mp3";
type ArtifactKind = "audio" | "text";

type ArtifactRecord = {
  id: string;
  kind: ArtifactKind;
  buffer: Buffer;
  mimeType: string;
  filename: string;
  createdAt: number;
  expiresAt: number;
};

type JsonLineEvent = {
  type?: string;
  data?: unknown;
  details?: unknown;
  code?: unknown;
};

type ParsedJsonLineResult = {
  stdout: string[];
  stderr: string[];
  result: Record<string, unknown> | null;
  errors: string[];
  exitCode: number | null;
};

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

const artifacts = new Map<string, ArtifactRecord>();

const packageCatalog = [
  { tokens: 10, priceUsd: 0.9 },
  { tokens: 100, priceUsd: 8.9 },
  { tokens: 500, priceUsd: 34.9 },
] as const;

const modeCatalog: Record<
  ConversionMode,
  {
    route: string;
    code: "v2m" | "v2w" | "m2w" | "w2m";
    input: string;
    output: string;
    title: string;
  }
> = {
  video_to_mp3: {
    route: "/api/video2mp3",
    code: "v2m",
    input: "Remote video URL",
    output: "MP3 or WAV audio",
    title: "Video to MP3",
  },
  video_to_word: {
    route: "/api/video2word",
    code: "v2w",
    input: "Remote video URL",
    output: "Transcript text",
    title: "Video to Word",
  },
  mp3_to_word: {
    route: "/api/mp32word",
    code: "m2w",
    input: "Remote audio URL",
    output: "Transcript text",
    title: "MP3 to Word",
  },
  word_to_mp3: {
    route: "/api/word2mp3",
    code: "w2m",
    input: "Plain text",
    output: "MP3 or WAV audio",
    title: "Word to MP3",
  },
};

function getRequestBaseUrl(req: Request, config: ServerConfig): string | undefined {
  if (config.publicBaseUrl) {
    return config.publicBaseUrl;
  }

  const host = req.get("host");
  if (!host) {
    return undefined;
  }

  return `${req.protocol}://${host}`;
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
    id: id ?? null,
  };
}

function isRestrictedToolCall(req: Request): boolean {
  const method = req.body?.method;
  const toolName = req.body?.params?.name;

  return (
    method === "tools/call" &&
    (toolName === "videomp3word_convert" || toolName === "videomp3word_token_balance" || toolName === "videomp3word_pay")
  );
}

function isAuthorizedRequest(req: Request, config: ServerConfig): boolean {
  if (config.accessKeys.size === 0) {
    return true;
  }

  const authHeader = req.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }

  return config.accessKeys.has(match[1].trim());
}

function hasServiceCredentials(config: ServerConfig): boolean {
  return Boolean(config.sessionCookie || config.upstreamApiKey);
}

function buildUpstreamHeaders(config: ServerConfig): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain;q=0.9, */*;q=0.8",
  };

  if (config.sessionCookie) {
    headers.cookie = config.sessionCookie;
  }

  if (config.upstreamApiKey) {
    headers.authorization = `Bearer ${config.upstreamApiKey}`;
  }

  return headers;
}

function estimateTextTokens(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return text.length + cjkCount;
}

function artifactUrl(publicBaseUrl: string | undefined, artifactId: string): string | undefined {
  if (!publicBaseUrl) {
    return undefined;
  }

  return `${publicBaseUrl}/artifacts/${artifactId}`;
}

function createArtifact(
  kind: ArtifactKind,
  buffer: Buffer,
  mimeType: string,
  filename: string,
  publicBaseUrl: string | undefined,
  config: ServerConfig
) {
  const id = randomUUID();
  const record: ArtifactRecord = {
    id,
    kind,
    buffer,
    mimeType,
    filename,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.artifactTtlMs,
  };

  artifacts.set(id, record);

  setTimeout(() => {
    artifacts.delete(id);
  }, config.artifactTtlMs).unref();

  return {
    artifactId: id,
    downloadUrl: artifactUrl(publicBaseUrl, id),
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  if (parts[0] === 10 || parts[0] === 127) {
    return true;
  }

  if (parts[0] === 169 && parts[1] === 254) {
    return true;
  }

  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }

  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }

  if (parts[0] === 0) {
    return true;
  }

  return false;
}

function isPrivateIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    return isPrivateIpv4(address);
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  return false;
}

async function assertSafeRemoteUrl(input: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Input URL is invalid.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local or internal URLs are not allowed.");
  }

  const resolved = await dns.lookup(hostname, { all: true }).catch(() => []);
  if (resolved.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("Private-network URLs are not allowed.");
  }

  return parsed;
}

async function readResponseText(response: globalThis.Response): Promise<string> {
  return response.text();
}

async function extractUpstreamError(response: globalThis.Response): Promise<string> {
  const text = await readResponseText(response);
  try {
    const parsed = JSON.parse(text) as { error?: string; details?: string };
    const pieces = [parsed.error, parsed.details].filter(Boolean);
    if (pieces.length > 0) {
      return pieces.join(": ");
    }
  } catch {}

  return text || `Upstream request failed with status ${response.status}.`;
}

async function parseJsonLineResponse(response: globalThis.Response): Promise<ParsedJsonLineResult> {
  const result: ParsedJsonLineResult = {
    stdout: [],
    stderr: [],
    result: null,
    errors: [],
    exitCode: null,
  };

  if (!response.body) {
    return result;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: JsonLineEvent | null = null;
      try {
        parsed = JSON.parse(trimmed) as JsonLineEvent;
      } catch {
        result.stdout.push(line);
        continue;
      }

      if (parsed.type === "stdout" && typeof parsed.data === "string") {
        result.stdout.push(parsed.data);
        continue;
      }

      if (parsed.type === "stderr" && typeof parsed.data === "string") {
        result.stderr.push(parsed.data);
        continue;
      }

      if (parsed.type === "result" && parsed.data && typeof parsed.data === "object") {
        result.result = parsed.data as Record<string, unknown>;
        continue;
      }

      if (parsed.type === "error") {
        const message =
          typeof parsed.data === "string"
            ? parsed.data
            : typeof parsed.details === "string"
            ? parsed.details
            : "Upstream conversion failed.";
        result.errors.push(message);
        continue;
      }

      if (parsed.type === "exit" && typeof parsed.code === "number") {
        result.exitCode = parsed.code;
      }
    }
  }

  if (buffer.trim()) {
    result.stdout.push(buffer);
  }

  return result;
}

async function fetchTaskPrice(config: ServerConfig, mode: ConversionMode) {
  const url = new URL("/api/task-token-price", config.baseUrl);
  url.searchParams.set("code", modeCatalog[mode].code);
  const response = await fetch(url, {
    headers: buildUpstreamHeaders(config),
  }).catch(() => null);

  if (!response || !response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as
    | { task_token_price?: number | string }
    | null;

  const price = Number(payload?.task_token_price);
  return Number.isFinite(price) ? price : null;
}

async function fetchProfile(config: ServerConfig) {
  if (!config.sessionCookie) {
    throw new Error("VIDEOMP3WORD_SESSION_COOKIE is required to read the shared token balance.");
  }

  const response = await fetch(new URL("/api/profile", config.baseUrl), {
    headers: buildUpstreamHeaders(config),
  });

  if (!response.ok) {
    throw new Error(await extractUpstreamError(response));
  }

  return (await response.json()) as {
    user_available_quota?: { tokens_left?: number; updated_time?: string };
    quotas?: Array<Record<string, unknown>>;
  };
}

async function callUpstreamConversion(
  config: ServerConfig,
  mode: ConversionMode,
  payload: Record<string, unknown>
) {
  if (!hasServiceCredentials(config)) {
    throw new Error(
      "This deployment is missing upstream credentials. Set VIDEOMP3WORD_SESSION_COOKIE before publishing."
    );
  }

  const response = await fetch(new URL(modeCatalog[mode].route, config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildUpstreamHeaders(config),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await extractUpstreamError(response));
  }

  return parseJsonLineResponse(response);
}

function buildCatalogText(taskPrices: Partial<Record<ConversionMode, number | null>>) {
  const lines = [
    "Videomp3word gives bots one MCP endpoint for the full video, audio, and text workflow.",
    "",
    "Modes",
    ...Object.entries(modeCatalog).map(
      ([mode, details]) =>
        `- ${mode}: ${details.input} -> ${details.output}${
          taskPrices[mode as ConversionMode] != null
            ? ` | current task price: ${Number(taskPrices[mode as ConversionMode]).toFixed(2)} tokens`
            : ""
        }`
    ),
    "",
    "Why bots like this endpoint",
    "- One integration covers video to mp3, video to word, mp3 to word, and word to mp3.",
    "- Billing follows token consumption instead of subscription duration, so idle time does not create waste.",
    "- Packages stay simple and competitive: 10 tokens for USD $0.90, 100 for USD $8.90, 500 for USD $34.90.",
  ];

  return lines.join("\n");
}

function createServer(config: ServerConfig, publicBaseUrl: string | undefined) {
  const server = new McpServer({
    name: "videomp3word-mcp",
    version: "1.0.0",
  });

  server.registerResource(
    "videomp3word-catalog",
    "videomp3word://catalog",
    {
      title: "Videomp3word Catalog",
      description: "Overview of modes, billing style, and purchase entrypoints for bots.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const taskPrices = Object.fromEntries(
        await Promise.all(
          (Object.keys(modeCatalog) as ConversionMode[]).map(async (mode) => [mode, await fetchTaskPrice(config, mode)])
        )
      ) as Partial<Record<ConversionMode, number | null>>;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: buildCatalogText(taskPrices),
          },
        ],
      };
    }
  );

  server.registerTool(
    "videomp3word_catalog",
    {
      title: "Videomp3word Catalog",
      description: "Summarize the one-endpoint workflow, token billing advantage, and bot onboarding links.",
      inputSchema: z.object({}),
    },
    async () => {
      const taskPrices = Object.fromEntries(
        await Promise.all(
          (Object.keys(modeCatalog) as ConversionMode[]).map(async (mode) => [mode, await fetchTaskPrice(config, mode)])
        )
      ) as Partial<Record<ConversionMode, number | null>>;

      const output = {
        endpointAdvantage:
          "One MCP endpoint covers video to mp3, video to word, mp3 to word, and word to mp3 so bots do not need separate adapters.",
        tokenBillingAdvantage:
          "Billing is tied to consumed task tokens instead of subscription duration, so unused time is not billed.",
        pricingPackages: packageCatalog,
        taskTokenPrices: taskPrices,
        purchaseUrl: config.purchaseUrl,
        keyPortalUrl: config.keyPortalUrl,
        supportUrl: config.supportUrl,
      };

      return {
        content: [{ type: "text", text: buildCatalogText(taskPrices) }],
        structuredContent: output,
      };
    }
  );

  server.registerTool(
    "videomp3word_pricing",
    {
      title: "Videomp3word Pricing",
      description: "Return live task-token prices plus package prices for bots evaluating cost.",
      inputSchema: z.object({}),
    },
    async () => {
      const taskPrices = Object.fromEntries(
        await Promise.all(
          (Object.keys(modeCatalog) as ConversionMode[]).map(async (mode) => [mode, await fetchTaskPrice(config, mode)])
        )
      ) as Partial<Record<ConversionMode, number | null>>;

      const output = {
        packages: packageCatalog,
        taskTokenPrices: taskPrices,
        billingModel:
          "Token-based billing tracks actual work performed, which is usually a better fit for bots than time-based subscriptions.",
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
        structuredContent: output,
      };
    }
  );

  server.registerTool(
    "videomp3word_buy_access",
    {
      title: "Buy Access",
      description: "Explain how a bot buys access, gets a key, and starts using the public MCP deployment.",
      inputSchema: z.object({}),
    },
    async () => {
      const output = {
        purchaseUrl: config.purchaseUrl,
        keyPortalUrl: config.keyPortalUrl,
        supportUrl: config.supportUrl,
        packages: packageCatalog,
        notes: [
          "Buy tokens from the configured purchase URL.",
          "Retrieve the bot access key from the configured key portal.",
          "Reconnect to the MCP endpoint with Authorization: Bearer <key> when access keys are enabled.",
        ],
      };

      return {
        content: [
          {
            type: "text",
            text: `Purchase: ${config.purchaseUrl}\nKey portal: ${config.keyPortalUrl}\nSupport: ${config.supportUrl}`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  server.registerTool(
    "videomp3word_pay",
    {
      title: "Pay for Tokens",
      description: "Generate a Stripe checkout session URL for bots with pay authority to buy tokens directly.",
      inputSchema: z.object({
        packageTokens: z.enum(["10", "100", "500"]).describe("How many tokens to buy per package"),
        quantity: z.number().min(1).max(100).optional().describe("Number of packages to buy"),
      }),
    },
    async ({ packageTokens, quantity = 1 }) => {
      const packageName = `${packageTokens} Tokens`;
      const payload = new URLSearchParams();
      payload.append("packageName", packageName);
      payload.append("quantity", String(quantity));

      const response = await fetch(new URL("/api/stripe/create-checkout-session", config.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...buildUpstreamHeaders(config),
        },
        body: payload.toString(),
      });

      if (!response.ok) {
        throw new Error(await extractUpstreamError(response));
      }

      const json = await response.json() as { url?: string };
      if (!json.url) {
        throw new Error("No checkout URL returned from upstream.");
      }

      return {
        content: [
          {
            type: "text",
            text: `Payment session created successfully. Please complete your payment at this URL: ${json.url}`,
          },
        ],
        structuredContent: { checkoutUrl: json.url },
      };
    }
  );

  server.registerTool(
    "videomp3word_token_balance",
    {
      title: "Token Balance",
      description: "Check the shared videomp3word token balance available to this public MCP deployment.",
      inputSchema: z.object({}),
    },
    async () => {
      const profile = await fetchProfile(config);
      const tokensLeft = Number(profile.user_available_quota?.tokens_left ?? 0);
      const output = {
        tokensLeft,
        updatedTime: profile.user_available_quota?.updated_time ?? null,
        quotaRows: profile.quotas ?? [],
      };

      return {
        content: [
          {
            type: "text",
            text: `Tokens left: ${tokensLeft.toFixed(2)}`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  server.registerTool(
    "videomp3word_convert",
    {
      title: "Convert Media",
      description: "Run any videomp3word mode through one endpoint: video↔audio↔text workflows for bots.",
      inputSchema: z.object({
        mode: z.enum(["video_to_mp3", "video_to_word", "mp3_to_word", "word_to_mp3"]),
        sourceUrl: z.string().url().optional(),
        text: z.string().optional(),
        format: z.enum(["mp3", "wav"]).optional(),
        voice: z.string().min(1).max(100).optional(),
        languageType: z.string().min(1).max(100).optional(),
      }),
    },
    async ({ mode, sourceUrl, text, format, voice, languageType }) => {
      if (mode === "word_to_mp3") {
        const rawText = text?.trim() || "";
        if (!rawText) {
          throw new Error("text is required for word_to_mp3.");
        }

        if (estimateTextTokens(rawText) > 12000) {
          throw new Error("text exceeds the 12000-token upstream limit.");
        }

        const parsed = await callUpstreamConversion(config, mode, {
          text: rawText,
          format: format || "mp3",
          voice,
          languageType,
        });

        const audio = parsed.result?.audio as
          | {
              url?: unknown;
              data?: unknown;
              mime?: unknown;
              filename?: unknown;
              format?: unknown;
            }
          | undefined;

        if (!audio) {
          throw new Error(parsed.errors[0] || "No audio result returned.");
        }

        if (typeof audio.url === "string") {
          const output = {
            mode,
            audioUrl: audio.url,
            format: String(audio.format || format || "mp3"),
            filename: typeof audio.filename === "string" ? audio.filename : `output.${format || "mp3"}`,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        if (typeof audio.data === "string") {
          const mimeType = typeof audio.mime === "string" ? audio.mime : "audio/mpeg";
          const filename = typeof audio.filename === "string" ? audio.filename : `output.${format || "mp3"}`;
          const artifact = createArtifact(
            "audio",
            Buffer.from(audio.data, "base64"),
            mimeType,
            filename,
            publicBaseUrl,
            config
          );

          const output = {
            mode,
            filename,
            mimeType,
            ...artifact,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        throw new Error(parsed.errors[0] || "No audio payload returned.");
      }

      if (!sourceUrl) {
        throw new Error("sourceUrl is required for this mode.");
      }

      const safeUrl = await assertSafeRemoteUrl(sourceUrl);

      if (mode === "video_to_mp3") {
        const parsed = await callUpstreamConversion(config, mode, {
          url: safeUrl.href,
          format: format || "mp3",
        });

        const audio = parsed.result?.audio as
          | {
              url?: unknown;
              data?: unknown;
              mime?: unknown;
              filename?: unknown;
              format?: unknown;
            }
          | undefined;

        if (!audio) {
          throw new Error(parsed.errors[0] || "No audio result returned.");
        }

        if (typeof audio.url === "string") {
          const output = {
            mode,
            sourceUrl: safeUrl.href,
            audioUrl: audio.url,
            format: String(audio.format || format || "mp3"),
            filename: typeof audio.filename === "string" ? audio.filename : `output.${format || "mp3"}`,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        if (typeof audio.data === "string") {
          const mimeType = typeof audio.mime === "string" ? audio.mime : "audio/mpeg";
          const filename = typeof audio.filename === "string" ? audio.filename : `output.${format || "mp3"}`;
          const artifact = createArtifact(
            "audio",
            Buffer.from(audio.data, "base64"),
            mimeType,
            filename,
            publicBaseUrl,
            config
          );

          const output = {
            mode,
            sourceUrl: safeUrl.href,
            filename,
            mimeType,
            ...artifact,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        throw new Error(parsed.errors[0] || "No audio payload returned.");
      }

      const parsed = await callUpstreamConversion(config, mode, {
        url: safeUrl.href,
      });

      const transcript = parsed.stdout.join("").trim();
      if (!transcript) {
        throw new Error(parsed.errors[0] || "No transcript returned.");
      }

      const artifact = createArtifact(
        "text",
        Buffer.from(transcript, "utf-8"),
        "text/plain; charset=utf-8",
        `${mode}-${Date.now()}.txt`,
        publicBaseUrl,
        config
      );

      const output = {
        mode,
        sourceUrl: safeUrl.href,
        transcript,
        ...artifact,
      };

      return {
        content: [{ type: "text", text: transcript }],
        structuredContent: output,
      };
    }
  );

  return server;
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "videomp3word-mcp",
    hasAccessKeys: serverConfig.accessKeys.size > 0,
    hasUpstreamCredentials: hasServiceCredentials(serverConfig),
  });
});

app.get("/artifacts/:artifactId", (req, res) => {
  const artifact = artifacts.get(req.params.artifactId);
  if (!artifact || artifact.expiresAt < Date.now()) {
    artifacts.delete(req.params.artifactId);
    res.status(404).json({ error: "Artifact not found or expired." });
    return;
  }

  res.setHeader("Content-Type", artifact.mimeType);
  res.setHeader("Content-Length", String(artifact.buffer.length));
  res.setHeader("Content-Disposition", `attachment; filename="${artifact.filename}"`);
  res.send(artifact.buffer);
});

app.get("/mcp", (_req, res) => {
  res.status(405).json(jsonRpcError(null, -32000, "Use HTTP POST for MCP requests."));
});

app.post("/mcp", async (req: Request, res: ExpressResponse) => {
  if (isRestrictedToolCall(req) && !isAuthorizedRequest(req, serverConfig)) {
    res.status(401).json(jsonRpcError(req.body?.id ?? null, -32001, "Unauthorized. Provide a valid bearer key."));
    return;
  }

  try {
    const publicBaseUrl = getRequestBaseUrl(req, serverConfig);
    const server = createServer(serverConfig, publicBaseUrl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error.";
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(req.body?.id ?? null, -32603, message));
    }
  }
});

const isStdio = process.argv.includes("stdio");

if (isStdio) {
  async function runStdio() {
    const server = createServer(serverConfig, serverConfig.publicBaseUrl);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`videomp3word-mcp listening on stdio with upstream ${serverConfig.baseUrl}`);
  }
  runStdio().catch((error) => {
    console.error("Fatal error running stdio server:", error);
    process.exit(1);
  });
} else {
  app.listen(serverConfig.port, serverConfig.host, () => {
    console.error(
      `videomp3word-mcp listening on http://${serverConfig.host}:${serverConfig.port} with upstream ${serverConfig.baseUrl}`
    );
  });
}
