import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  HerdrClient,
  deriveMetadataSource,
  normalizeCustomStatus,
  resolveHerdrEnv,
  validSourceId,
} from "../src/herdr-client";

type CapturedRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

async function startFakeHerdrSocket(socketPath: string) {
  const requests: CapturedRequest[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          requests.push(JSON.parse(line));
          socket.write(JSON.stringify({ id: requests.at(-1)?.id, result: { type: "ok" } }) + "\n");
        }
        newline = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return { server, requests };
}

let tempDir = "";
let server: Server | undefined;

beforeEach(() => {
  tempDir = `/tmp/letta-herdr-mod-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(tempDir, { recursive: true });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveHerdrEnv", () => {
  test("is disabled outside a Herdr pane", () => {
    const env = resolveHerdrEnv({});
    expect(env.enabled).toBe(false);
    if (env.enabled) throw new Error("expected disabled env");
    expect(env.reason).toBe("HERDR_ENV is not 1");
  });

  test("requires socket path and pane id", () => {
    expect(resolveHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }).enabled).toBe(false);
    expect(resolveHerdrEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/x" }).enabled).toBe(false);
  });

  test("returns Herdr pane settings", () => {
    const env = resolveHerdrEnv({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "w1:p1",
      HERDR_BIN_PATH: "/usr/local/bin/herdr",
    });
    expect(env).toEqual({
      enabled: true,
      socketPath: "/tmp/herdr.sock",
      paneId: "w1:p1",
      binPath: "/usr/local/bin/herdr",
    });
  });
});

describe("validation helpers", () => {
  test("validates Herdr source ids", () => {
    expect(validSourceId("letta-code:mod")).toBe(true);
    expect(validSourceId("user.source_1-ok")).toBe(true);
    expect(validSourceId("")).toBe(false);
    expect(validSourceId("contains space")).toBe(false);
    expect(validSourceId("x".repeat(81))).toBe(false);
  });

  test("derives a stable metadata source id", () => {
    expect(deriveMetadataSource("letta-code:mod")).toBe("letta-code:mod:metadata");
    expect(deriveMetadataSource("x".repeat(80))).toBe(`${"x".repeat(75)}:meta`);
  });

  test("normalizes custom status for Herdr display", () => {
    expect(normalizeCustomStatus("  thinking\nnow  ")).toBe("thinkingnow");
    expect(normalizeCustomStatus("x".repeat(40))).toBe("x".repeat(32));
    expect(normalizeCustomStatus("   ")).toBeUndefined();
    expect(normalizeCustomStatus(undefined)).toBeUndefined();
  });
});

describe("HerdrClient", () => {
  test("reports semantic agent state over JSON-lines socket", async () => {
    const socketPath = join(tempDir, "herdr.sock");
    const fake = await startFakeHerdrSocket(socketPath);
    server = fake.server;

    const client = new HerdrClient({
      env: {
        enabled: true,
        socketPath,
        paneId: "w1:p1",
        binPath: undefined,
      },
      source: "letta-code:mod",
      agent: "letta-code",
      requestTimeoutMs: 250,
    });

    const result = await client.reportAgent({
      state: "working",
      customStatus: "thinking",
      seq: 42,
      agentSessionId: "conv-123",
    });

    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "pane.report_agent",
      params: {
        pane_id: "w1:p1",
        source: "letta-code:mod",
        agent: "letta-code",
        state: "working",
        seq: 42,
        agent_session_id: "conv-123",
      },
    });
    expect(fake.requests[0]?.params).not.toHaveProperty("custom_status");
  });

  test("reports display metadata separately from lifecycle state", async () => {
    const socketPath = join(tempDir, "herdr.sock");
    const fake = await startFakeHerdrSocket(socketPath);
    server = fake.server;

    const client = new HerdrClient({
      env: {
        enabled: true,
        socketPath,
        paneId: "w1:p1",
        binPath: undefined,
      },
      source: "letta-code:mod",
      agent: "letta-code",
      displayAgent: "Johnny5",
      requestTimeoutMs: 250,
    });

    const result = await client.reportMetadata({
      customStatus: "thinking\nnow",
      stateLabels: { working: "thinking\nnow" },
      seq: 43,
    });

    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "pane.report_metadata",
      params: {
        pane_id: "w1:p1",
        source: "letta-code:mod:metadata",
        agent: "letta-code",
        applies_to_source: "letta-code:mod",
        display_agent: "Johnny5",
        tokens: { summary: "thinkingnow" },
        state_labels: { working: "thinkingnow" },
        seq: 43,
      },
    });
  });

  test("clears this mod's lifecycle authority over JSON-lines socket", async () => {
    const socketPath = join(tempDir, "herdr.sock");
    const fake = await startFakeHerdrSocket(socketPath);
    server = fake.server;

    const client = new HerdrClient({
      env: { enabled: true, socketPath, paneId: "w1:p1", binPath: undefined },
      source: "letta-code:mod",
      agent: "letta-code",
      requestTimeoutMs: 250,
    });

    const result = await client.clearAgentAuthority({ seq: 44 });

    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "pane.clear_agent_authority",
      params: {
        pane_id: "w1:p1",
        source: "letta-code:mod",
        seq: 44,
      },
    });
  });

  test("releases agent authority over JSON-lines socket", async () => {
    const socketPath = join(tempDir, "herdr.sock");
    const fake = await startFakeHerdrSocket(socketPath);
    server = fake.server;

    const client = new HerdrClient({
      env: { enabled: true, socketPath, paneId: "w1:p1", binPath: undefined },
      source: "letta-code:mod",
      agent: "letta-code",
      requestTimeoutMs: 250,
    });

    const result = await client.releaseAgent({ seq: 99, agentSessionId: "conv-123" });

    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "pane.release_agent",
      params: {
        pane_id: "w1:p1",
        source: "letta-code:mod",
        agent: "letta-code",
        seq: 99,
        agent_session_id: "conv-123",
      },
    });
  });

  test("skips reporting when disabled instead of throwing", async () => {
    const client = new HerdrClient({
      env: { enabled: false, reason: "HERDR_ENV is not 1" },
      source: "letta-code:mod",
      agent: "letta-code",
    });

    const result = await client.reportAgent({ state: "idle", seq: 1 });
    expect(result).toEqual({ ok: false, skipped: true, reason: "HERDR_ENV is not 1" });
  });

  test("turns socket failures into error results", async () => {
    const client = new HerdrClient({
      env: { enabled: true, socketPath: join(tempDir, "missing.sock"), paneId: "w1:p1", binPath: undefined },
      source: "letta-code:mod",
      agent: "letta-code",
      requestTimeoutMs: 50,
    });

    const result = await client.reportAgent({ state: "working", seq: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error).toContain("connect");
  });
});
