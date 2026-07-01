import { Socket } from "node:net";

export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

export type ResolvedHerdrEnv =
  | {
      enabled: true;
      socketPath: string;
      paneId: string;
      binPath: string | undefined;
    }
  | {
      enabled: false;
      reason: string;
    };

export type HerdrResult =
  | { ok: true; response?: unknown }
  | { ok: false; skipped?: true; reason?: string; error?: string };

export type ReportAgentInput = {
  state: HerdrAgentState;
  customStatus?: string | undefined;
  message?: string | undefined;
  seq: number;
  agentSessionId?: string | undefined;
  agentSessionPath?: string | undefined;
};

export type ReleaseAgentInput = {
  seq: number;
  agentSessionId?: string | undefined;
};

export type HerdrClientOptions = {
  env?: ResolvedHerdrEnv | undefined;
  source?: string | undefined;
  agent?: string | undefined;
  requestTimeoutMs?: number | undefined;
};

type JsonRpcRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

const SOURCE_ID_RE = /^[A-Za-z0-9:._-]{1,80}$/;

export function resolveHerdrEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): ResolvedHerdrEnv {
  if (env.HERDR_ENV !== "1") {
    return { enabled: false, reason: "HERDR_ENV is not 1" };
  }

  const socketPath = env.HERDR_SOCKET_PATH?.trim();
  if (!socketPath) {
    return { enabled: false, reason: "HERDR_SOCKET_PATH is not set" };
  }

  const paneId = env.HERDR_PANE_ID?.trim();
  if (!paneId) {
    return { enabled: false, reason: "HERDR_PANE_ID is not set" };
  }

  return {
    enabled: true,
    socketPath,
    paneId,
    binPath: env.HERDR_BIN_PATH?.trim() || undefined,
  };
}

export function validSourceId(source: string): boolean {
  return SOURCE_ID_RE.test(source);
}

export function normalizeCustomStatus(status: string | undefined): string | undefined {
  if (status == null) return undefined;
  const normalized = status.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 32);
}

export class HerdrClient {
  readonly env: ResolvedHerdrEnv;
  readonly source: string;
  readonly agent: string;
  readonly requestTimeoutMs: number;

  constructor(options: HerdrClientOptions = {}) {
    this.env = options.env ?? resolveHerdrEnv();
    this.source = options.source ?? process.env.LETTA_HERDR_SOURCE ?? "letta-code:mod";
    this.agent = options.agent ?? process.env.LETTA_HERDR_AGENT ?? "letta-code";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1_000;

    if (!validSourceId(this.source)) {
      throw new Error(`Invalid Herdr source id: ${this.source}`);
    }
  }

  async reportAgent(input: ReportAgentInput): Promise<HerdrResult> {
    const params: Record<string, unknown> = {
      pane_id: this.paneId(),
      source: this.source,
      agent: this.agent,
      state: input.state,
      seq: input.seq,
    };

    const customStatus = normalizeCustomStatus(input.customStatus);
    if (customStatus) params.custom_status = customStatus;
    if (input.message) params.message = input.message;
    if (input.agentSessionId) params.agent_session_id = input.agentSessionId;
    if (input.agentSessionPath) params.agent_session_path = input.agentSessionPath;

    return this.sendRequest("pane.report_agent", params);
  }

  async releaseAgent(input: ReleaseAgentInput): Promise<HerdrResult> {
    const params: Record<string, unknown> = {
      pane_id: this.paneId(),
      source: this.source,
      agent: this.agent,
      seq: input.seq,
    };
    if (input.agentSessionId) params.agent_session_id = input.agentSessionId;

    return this.sendRequest("pane.release_agent", params);
  }

  async sendRequest(method: string, params: Record<string, unknown>): Promise<HerdrResult> {
    if (!this.env.enabled) {
      return { ok: false, skipped: true, reason: this.env.reason };
    }

    const request: JsonRpcRequest = {
      id: `letta-herdr-mod-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      params,
    };

    try {
      const response = await sendJsonLine(this.env.socketPath, request, this.requestTimeoutMs);
      return { ok: true, response };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private paneId(): string | undefined {
    return this.env.enabled ? this.env.paneId : undefined;
  }
}

function sendJsonLine(socketPath: string, request: JsonRpcRequest, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for Herdr socket response`)));
    }, timeoutMs);

    const clearAndFinish = (fn: () => void) => {
      clearTimeout(timeout);
      finish(fn);
    };

    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      clearAndFinish(() => reject(error));
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      const line = buffer.slice(0, newline).trim();
      if (!line) return;

      clearAndFinish(() => {
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve(line);
        }
      });
    });
    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.connect(socketPath);
  });
}
