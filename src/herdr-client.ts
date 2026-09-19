import { createHash, randomUUID } from "node:crypto";
import { Socket } from "node:net";

export type ResolvedHerdrEnv =
  | { enabled: true; socketPath: string; paneId: string }
  | { enabled: false; reason: string };
export type HerdrResult =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; error: string };
export type MetadataInput = { seq: number } & (
  | { kind: "name"; displayAgent: string; clear?: never }
  | { kind: "activity"; working: string; ttlMs: number; clear?: never }
  | {
      kind: "name" | "activity";
      clear: true;
      displayAgent?: never;
      working?: never;
      ttlMs?: never;
    }
);
export type HerdrClientOptions = {
  env?: ResolvedHerdrEnv;
  source?: string | undefined;
  requestTimeoutMs?: number;
};
export const MAX_TTL_MS = 86_400_000;
export function validTtl(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_TTL_MS;
}
export function resolveHerdrEnv(
  env: Record<string, string | undefined> = process.env,
): ResolvedHerdrEnv {
  if (env.HERDR_ENV !== "1")
    return { enabled: false, reason: "HERDR_ENV is not 1" };
  const socketPath = env.HERDR_SOCKET_PATH?.trim();
  const paneId = env.HERDR_PANE_ID?.trim();
  if (!socketPath)
    return { enabled: false, reason: "HERDR_SOCKET_PATH is not set" };
  if (!paneId) return { enabled: false, reason: "HERDR_PANE_ID is not set" };
  return { enabled: true, socketPath, paneId };
}
export function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return (
    Array.from(value.replace(/\p{Cc}/gu, "").trim())
      .slice(0, 80)
      .join("")
      .trim() || undefined
  );
}
export function deriveMetadataSources(prefix: string): {
  name: string;
  activity: string;
} {
  if (!/^[A-Za-z0-9:._-]{1,80}$/.test(prefix))
    throw new Error("Invalid Herdr source prefix");
  // Hash the entire prefix, never truncate away the distinguishing suffix.
  const base = `${prefix.slice(0, 30)}:${createHash("sha256").update(prefix).digest("hex").slice(0, 32)}`;
  return { name: `${base}:name`, activity: `${base}:activity` };
}
export class HerdrClient {
  readonly env: ResolvedHerdrEnv;
  readonly sources: { name: string; activity: string };
  readonly laneKey: string;
  readonly requestTimeoutMs: number;
  constructor(options: HerdrClientOptions = {}) {
    this.env = options.env ?? resolveHerdrEnv();
    this.sources = deriveMetadataSources(options.source ?? "letta-code:mod");
    this.laneKey = JSON.stringify([
      this.env.enabled ? this.env.socketPath : null,
      this.env.enabled ? this.env.paneId : null,
      this.sources.name,
    ]);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1000;
  }
  async reportMetadata(input: MetadataInput): Promise<HerdrResult> {
    const raw = input as unknown as Record<string, unknown>;
    if (
      !Number.isSafeInteger(input.seq) ||
      input.seq < 0 ||
      !["name", "activity"].includes(input.kind)
    )
      return { ok: false, error: "Invalid metadata request" };
    if (
      input.clear &&
      (raw.displayAgent !== undefined ||
        raw.working !== undefined ||
        raw.ttlMs !== undefined)
    )
      return { ok: false, error: "Cannot set and clear metadata together" };
    const params: Record<string, unknown> = {
      pane_id: this.env.enabled ? this.env.paneId : undefined,
      source: this.sources[input.kind],
      agent: "letta",
      seq: input.seq,
    };
    if (input.clear)
      params[
        input.kind === "name" ? "clear_display_agent" : "clear_state_labels"
      ] = true;
    else if (input.kind === "name") {
      const name = normalizeLabel(input.displayAgent);
      if (!name) return { ok: false, error: "Empty display name" };
      params.display_agent = name;
    } else {
      const label = normalizeLabel(input.working);
      if (!label || !validTtl(input.ttlMs))
        return { ok: false, error: "Invalid activity label or TTL" };
      params.state_labels = { working: label };
      params.ttl_ms = input.ttlMs;
    }
    return this.#request("pane.report_metadata", params);
  }
  getPane(): Promise<HerdrResult> {
    return this.#request("pane.get", {
      pane_id: this.env.enabled ? this.env.paneId : undefined,
    });
  }
  async #request(
    method: "pane.get" | "pane.report_metadata",
    params: Record<string, unknown>,
  ): Promise<HerdrResult> {
    if (!this.env.enabled) return { ok: false, error: this.env.reason };
    try {
      const response = await sendJsonLine(
        this.env.socketPath,
        { id: randomUUID(), method, params },
        this.requestTimeoutMs,
      );
      return { ok: true, response };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Herdr transport failed",
      };
    }
  }
}
function sendJsonLine(
  path: string,
  request: { id: string; method: string; params: Record<string, unknown> },
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: string, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(new Error(error));
      else resolve(result!);
    };
    const timer = setTimeout(() => finish("Herdr response timeout"), timeoutMs);
    socket.on("error", () => finish("Herdr socket error"));
    socket.on("close", () => finish("Herdr disconnected without response"));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([
        buffer,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      if (buffer.length > 65_536) return finish("Herdr response exceeds limit");
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.id !== request.id ||
          "result" in value === "error" in value
        )
          return finish("Invalid Herdr response envelope");
        if ("error" in value) {
          const code =
            typeof value.error?.code === "string" &&
            /^[a-zA-Z0-9_-]{1,64}$/.test(value.error.code)
              ? value.error.code
              : "unknown";
          return finish(`Herdr server error: ${code}`);
        }
        if (
          !value.result ||
          typeof value.result !== "object" ||
          Array.isArray(value.result)
        )
          return finish("Invalid Herdr result");
        if (
          request.method === "pane.report_metadata" &&
          value.result.type !== "ok"
        )
          return finish("Unexpected Herdr metadata acknowledgement");
        finish(undefined, value.result);
      } catch {
        finish("Malformed Herdr JSON response");
      }
    });
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.connect(path);
  });
}
