import assert from "node:assert/strict";
import { fork, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type StartedServer = {
  server: ReturnType<typeof createServer>;
  url: string;
};

type SpawnedApp = import("node:child_process").ChildProcess;
type ToolTextContent = {
  type: "text";
  text: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => void
): Promise<StartedServer> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(server: ReturnType<typeof createServer>) {
  server.close();
  await once(server, "close");
}

async function waitForAppReady(process: SpawnedApp): Promise<void> {
  let stdout = "";
  let stderr = "";

  process.stdout?.setEncoding("utf8");
  process.stderr?.setEncoding("utf8");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for app startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);

    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("videomp3word-mcp listening on")) {
        cleanup();
        resolve();
      }
    };

    const onStderr = (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("videomp3word-mcp listening on")) {
        cleanup();
        resolve();
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`App exited before startup. code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      process.stdout?.off("data", onStdout);
      process.stderr?.off("data", onStderr);
      process.off("exit", onExit);
    };

    process.stdout?.on("data", onStdout);
    process.stderr?.on("data", onStderr);
    process.on("exit", onExit);
  });
}

async function stopProcess(process: SpawnedApp) {
  if (process.exitCode !== null || process.killed) {
    return;
  }

  process.kill("SIGTERM");
  await once(process, "exit");
}

function createClient(baseUrl: string, headers?: HeadersInit) {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client(
    {
      name: "smoke-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  return { client, transport };
}

function getToolText(result: unknown): string {
  assert.ok(result && typeof result === "object");
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const textItem = content.find((item): item is ToolTextContent => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const textContent = item as Partial<ToolTextContent>;
    return textContent.type === "text" && typeof textContent.text === "string";
  });

  assert.ok(textItem);
  return textItem.text;
}

test("bot access flow smoke test", async () => {
  const accessKey = "smoke-access-key";
  const sessionCookie = "session=smoke-cookie";
  let profileSawCookie = false;
  let convertSawCookie = false;

  const upstream = await startServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/api/profile") {
      profileSawCookie = req.headers.cookie === sessionCookie;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          user_available_quota: {
            tokens_left: 42.5,
            updated_time: "2026-03-25T00:00:00.000Z",
          },
          quotas: [],
        })
      );
      return;
    }

    if (url.pathname === "/api/word2mp3") {
      convertSawCookie = req.headers.cookie === sessionCookie;
      res.setHeader("content-type", "application/x-ndjson");
      res.write(
        `${JSON.stringify({
          type: "result",
          data: {
            audio: {
              data: Buffer.from("synthetic-audio").toString("base64"),
              mime: "audio/mpeg",
              filename: "sample.mp3",
              format: "mp3",
            },
          },
        })}\n`
      );
      res.end(`${JSON.stringify({ type: "exit", code: 0 })}\n`);
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  const appServer = createServer();
  appServer.listen(0, "127.0.0.1");
  await once(appServer, "listening");
  const appAddress = appServer.address() as AddressInfo;
  const appPort = appAddress.port;
  await stopServer(appServer);

  const baseUrl = `http://127.0.0.1:${appPort}`;
  const app = fork("dist/index.js", [], {
    cwd: repoRoot,
    env: {
      HOST: "127.0.0.1",
      PORT: String(appPort),
      PUBLIC_BASE_URL: baseUrl,
      VIDEOMP3WORD_BASE_URL: upstream.url,
      VIDEOMP3WORD_ALLOWED_UPSTREAM_HOSTS: "127.0.0.1",
      VIDEOMP3WORD_SESSION_COOKIE: sessionCookie,
      MCP_ACCESS_KEYS: accessKey,
      BOT_PURCHASE_URL: "https://example.com/buy",
      BOT_KEY_PORTAL_URL: "https://example.com/portal",
      BOT_SUPPORT_URL: "https://example.com/support",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  try {
    await waitForAppReady(app);

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      ok: true,
      name: "videomp3word-mcp",
      hasAccessKeys: true,
      hasUpstreamCredentials: true,
    });

    const unauthorizedResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "videomp3word_token_balance",
          arguments: {},
        },
      }),
    });

    assert.equal(unauthorizedResponse.status, 401);
    const unauthorizedPayload = (await unauthorizedResponse.json()) as {
      error?: { message?: string };
    };
    assert.match(unauthorizedPayload.error?.message || "", /valid bearer key/i);

    const publicAccess = createClient(baseUrl);
    await publicAccess.client.connect(publicAccess.transport);
    const buyAccess = await publicAccess.client.callTool({
      name: "videomp3word_buy_access",
      arguments: {},
    });
    const buyAccessText = getToolText(buyAccess);
    assert.match(buyAccessText, /https:\/\/example\.com\/buy/);
    assert.match(buyAccessText, /https:\/\/example\.com\/portal/);
    assert.match(buyAccessText, /https:\/\/example\.com\/support/);
    await publicAccess.transport.close();

    const authorizedAccess = createClient(baseUrl, {
      Authorization: `Bearer ${accessKey}`,
    });
    await authorizedAccess.client.connect(authorizedAccess.transport);

    const tokenBalance = await authorizedAccess.client.callTool({
      name: "videomp3word_token_balance",
      arguments: {},
    });
    const tokenBalanceText = getToolText(tokenBalance);
    assert.match(tokenBalanceText, /42\.50/);

    const conversion = await authorizedAccess.client.callTool({
      name: "videomp3word_convert",
      arguments: {
        mode: "word_to_mp3",
        text: "Hello from the smoke test.",
        format: "mp3",
      },
    });
    const conversionText = getToolText(conversion);
    const conversionPayload = JSON.parse(conversionText) as {
      filename: string;
      mimeType: string;
      downloadUrl: string;
    };

    assert.equal(conversionPayload.filename, "sample.mp3");
    assert.equal(conversionPayload.mimeType, "audio/mpeg");
    assert.match(conversionPayload.downloadUrl, new RegExp(`^${baseUrl}/artifacts/`));

    const artifactResponse = await fetch(conversionPayload.downloadUrl);
    assert.equal(artifactResponse.status, 200);
    assert.equal(artifactResponse.headers.get("content-type"), "audio/mpeg");
    assert.equal(await artifactResponse.text(), "synthetic-audio");

    assert.equal(profileSawCookie, true);
    assert.equal(convertSawCookie, true);

    await authorizedAccess.transport.close();
  } finally {
    await stopProcess(app);
    await stopServer(upstream.server);
  }
});
