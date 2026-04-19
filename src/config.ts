export type ServerConfig = {
  host: string;
  port: number;
  baseUrl: string;
  publicBaseUrl?: string;
  sessionCookie: string;
  upstreamApiKey?: string;
  accessKeys: Set<string>;
  mongoUri?: string;
  mongoDbName: string;
  knowledgeModelApiBase: string;
  knowledgeModelApiKey?: string;
  knowledgeModelName: string;
  knowledgeEvaluationModelName: string;
};

export function getConfig(): ServerConfig {
  const configuredBaseUrl = process.env.VIDEOMP3WORD_BASE_URL || "https://videomp3word.com";
  const sessionCookie = process.env.VIDEOMP3WORD_SESSION_COOKIE?.trim();
  if (!sessionCookie) {
    throw new Error("VIDEOMP3WORD_SESSION_COOKIE is required. Use a dedicated upstream videomp3word account for this deployment.");
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(configuredBaseUrl);
  } catch {
    throw new Error("VIDEOMP3WORD_BASE_URL must be a valid absolute URL.");
  }

  const allowedUpstreamHosts = new Set(
    String(process.env.VIDEOMP3WORD_ALLOWED_UPSTREAM_HOSTS || "videomp3word.com,www.videomp3word.com")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const upstreamHost = parsedBaseUrl.hostname.toLowerCase();
  if (!allowedUpstreamHosts.has(upstreamHost)) {
    throw new Error(`VIDEOMP3WORD_BASE_URL host "${upstreamHost}" is not allowed. Configure VIDEOMP3WORD_ALLOWED_UPSTREAM_HOSTS to permit it.`);
  }

  const accessKeys = new Set(
    String(process.env.MCP_ACCESS_KEYS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (nodeEnv === "production" && accessKeys.size === 0) {
    throw new Error("MCP_ACCESS_KEYS must be configured in production.");
  }

  return {
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT || 3000),
    baseUrl: parsedBaseUrl.toString().replace(/\/+$/, ""),
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.replace(/\/+$/, ""),
    sessionCookie,
    upstreamApiKey: process.env.VIDEOMP3WORD_API_KEY?.trim(),
    accessKeys,
    mongoUri: process.env.MONGO_URI?.trim(),
    mongoDbName: process.env.MONGO_DB_NAME?.trim() || "videomp3word_mcp",
    knowledgeModelApiBase: (process.env.KNOWLEDGE_MODEL_API_BASE || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
    knowledgeModelApiKey: process.env.KNOWLEDGE_MODEL_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim(),
    knowledgeModelName: process.env.KNOWLEDGE_MODEL_NAME?.trim() || "qwen-plus",
    knowledgeEvaluationModelName: process.env.KNOWLEDGE_EVALUATION_MODEL_NAME?.trim() || process.env.KNOWLEDGE_MODEL_NAME?.trim() || "qwen-plus",
  };
}

export const serverConfig = getConfig();
