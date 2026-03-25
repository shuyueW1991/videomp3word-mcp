export type ServerConfig = {
  host: string;
  port: number;
  baseUrl: string;
  publicBaseUrl?: string;
  sessionCookie?: string;
  upstreamApiKey?: string;
  purchaseUrl: string;
  keyPortalUrl: string;
  supportUrl: string;
  accessKeys: Set<string>;
  artifactTtlMs: number;
};

export function getConfig(): ServerConfig {
  const configuredBaseUrl = process.env.VIDEOMP3WORD_BASE_URL || "https://videomp3word.com";
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(configuredBaseUrl);
  } catch {
    throw new Error("VIDEOMP3WORD_BASE_URL must be a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    throw new Error("VIDEOMP3WORD_BASE_URL must use http or https.");
  }

  const allowedUpstreamHosts = new Set(
    String(process.env.VIDEOMP3WORD_ALLOWED_UPSTREAM_HOSTS || "videomp3word.com,www.videomp3word.com")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const upstreamHost = parsedBaseUrl.hostname.toLowerCase();
  if (!allowedUpstreamHosts.has(upstreamHost)) {
    throw new Error(
      `VIDEOMP3WORD_BASE_URL host "${upstreamHost}" is not allowed. Configure VIDEOMP3WORD_ALLOWED_UPSTREAM_HOSTS to permit it.`
    );
  }

  const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");
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
  const artifactTtlSeconds = Number(process.env.ARTIFACT_TTL_SECONDS || 1800);

  return {
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT || 3000),
    baseUrl,
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.replace(/\/+$/, ""),
    sessionCookie: process.env.VIDEOMP3WORD_SESSION_COOKIE?.trim(),
    upstreamApiKey: process.env.VIDEOMP3WORD_API_KEY?.trim(),
    purchaseUrl: (process.env.BOT_PURCHASE_URL || `${baseUrl}/profile`).trim(),
    keyPortalUrl: (process.env.BOT_KEY_PORTAL_URL || `${baseUrl}/contact`).trim(),
    supportUrl: (process.env.BOT_SUPPORT_URL || `${baseUrl}/contact`).trim(),
    accessKeys,
    artifactTtlMs: Math.max(60, Number.isFinite(artifactTtlSeconds) ? artifactTtlSeconds : 1800) * 1000,
  };
}

export const serverConfig = getConfig();
