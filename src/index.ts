import { HerdrClient, resolveHerdrEnv, type ResolvedHerdrEnv } from "./herdr-client";
import {
  DEFAULT_IDLE_DELAY_MS,
  DEFAULT_POST_TOOL_IDLE_MS,
  DEFAULT_STALE_WORKING_MS,
  DEFAULT_TOOL_WATCHDOG_MS,
  HerdrStateReporter,
  type HerdrReporterClient,
} from "./state-reporter";

type Dispose = () => void;

type LettaModApi = {
  capabilities?: {
    events?: {
      lifecycle?: boolean;
      turns?: boolean;
      tools?: boolean;
      llm?: boolean;
    };
    commands?: boolean;
    permissions?: boolean;
  };
  events?: {
    on(name: string, handler: (event: any, ctx?: any) => unknown): Dispose;
  };
  commands?: {
    register(command: {
      id: string;
      description: string;
      args?: string;
      showInTranscript?: boolean;
      run(ctx: any): unknown;
    }): Dispose;
  };
  permissions?: {
    register(overlay: {
      id: string;
      description: string;
      check(event: any): unknown;
    }): Dispose;
  };
};

type ReporterBundle = {
  env: ResolvedHerdrEnv;
  client?: HerdrReporterClient;
  reporter?: HerdrStateReporter;
};

let activeBundle: ReporterBundle | undefined;

export default function activate(letta: LettaModApi): Dispose | undefined {
  const disposers: Dispose[] = [];
  activeBundle = createReporterFromEnv(process.env);
  const reporter = activeBundle.reporter;

  if (letta.capabilities?.events?.lifecycle && letta.events) {
    disposers.push(
      letta.events.on("conversation_open", (event) => {
        void reporter?.onConversationOpen({ conversationId: event?.conversationId });
      }),
      letta.events.on("conversation_close", (event) => {
        void reporter?.release(event?.conversationId);
      }),
    );
  }

  if (letta.capabilities?.events?.turns && letta.events) {
    disposers.push(
      letta.events.on("turn_start", (event) => {
        void reporter?.onTurnStart({ conversationId: event?.conversationId });
      }),
      letta.events.on("turn_end", (event) => {
        reporter?.onTurnEnd({ conversationId: event?.conversationId });
      }),
    );
  }

  if (letta.capabilities?.events?.tools && letta.events) {
    disposers.push(
      letta.events.on("tool_start", (event) => {
        void reporter?.onToolStart({
          conversationId: event?.conversationId,
          toolName: String(event?.toolName ?? "tool"),
        });
      }),
      letta.events.on("tool_end", (event) => {
        void reporter?.onToolEnd({ conversationId: event?.conversationId });
      }),
    );
  }

  if (letta.capabilities?.events?.llm && letta.events) {
    disposers.push(
      letta.events.on("llm_start", (event) => {
        void reporter?.onLlmStart({ conversationId: event?.conversationId });
      }),
      letta.events.on("llm_end", (event) => {
        void reporter?.onLlmEnd({
          conversationId: event?.conversationId,
          stopReason: event?.stopReason,
          error: event?.error,
        });
      }),
    );
  }

  if (letta.capabilities?.permissions && letta.permissions) {
    disposers.push(
      letta.permissions.register({
        id: "letta-herdr-mod-approval-observer",
        description:
          "Optionally reports Herdr blocked state during Letta permission approval classification.",
        check(event) {
          void reporter?.onPermissionCheck({
            conversationId: event?.conversationId,
            phase: event?.phase,
          });
          return undefined;
        },
      }),
    );
  }

  if (letta.capabilities?.commands && letta.commands) {
    disposers.push(
      letta.commands.register({
        id: "herdr-status",
        description: "Show letta-herdr-mod connection and last-report status.",
        showInTranscript: false,
        run() {
          return { type: "output", output: formatStatus(activeBundle) };
        },
      }),
    );
  }

  return () => {
    void reporter?.release();
    for (const dispose of disposers.reverse()) {
      dispose();
    }
    activeBundle = undefined;
  };
}

export function createReporterFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ReporterBundle {
  const resolvedEnv = resolveHerdrEnv(env);
  if (!resolvedEnv.enabled) {
    return { env: resolvedEnv };
  }

  const client = new HerdrClient({
    env: resolvedEnv,
    source: env.LETTA_HERDR_SOURCE,
    agent: env.LETTA_HERDR_AGENT,
  });
  const reporter = new HerdrStateReporter(client, {
    idleDelayMs: parseIdleDelayMs(env.LETTA_HERDR_IDLE_DELAY_MS),
    staleWorkingMs: parseStaleWorkingMs(env.LETTA_HERDR_STALE_WORKING_MS),
    postToolIdleMs: parsePostToolIdleMs(env.LETTA_HERDR_POST_TOOL_IDLE_MS),
    toolWatchdogMs: parseToolWatchdogMs(env.LETTA_HERDR_TOOL_WATCHDOG_MS),
    reportApprovalBlocked: shouldReportApprovalBlocked(env),
  });

  return { env: resolvedEnv, client, reporter };
}

export function parseIdleDelayMs(value: string | undefined): number {
  return parseDurationMs(value, DEFAULT_IDLE_DELAY_MS, { allowZero: false });
}

export function parseStaleWorkingMs(value: string | undefined): number {
  return parseDurationMs(value, DEFAULT_STALE_WORKING_MS, { allowZero: true });
}

export function parsePostToolIdleMs(value: string | undefined): number {
  return parseDurationMs(value, DEFAULT_POST_TOOL_IDLE_MS, { allowZero: true });
}

export function parseToolWatchdogMs(value: string | undefined): number {
  return parseDurationMs(value, DEFAULT_TOOL_WATCHDOG_MS, { allowZero: true });
}

export function shouldReportApprovalBlocked(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const value = env.LETTA_HERDR_APPROVAL_BLOCKED?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function formatStatus(bundle: ReporterBundle | undefined): string {
  if (!bundle) return "letta-herdr-mod: not initialized";

  if (!bundle.env.enabled) {
    return ["letta-herdr-mod: disabled", `reason: ${bundle.env.reason}`].join("\n");
  }

  const snapshot = bundle.reporter?.snapshot();
  return [
    "letta-herdr-mod: enabled",
    `pane: ${bundle.env.paneId}`,
    `socket: ${bundle.env.socketPath}`,
    `last state: ${snapshot?.lastState ?? "none"}`,
    `last status: ${snapshot?.lastCustomStatus ?? "none"}`,
    `last conversation: ${snapshot?.lastConversationId ?? "none"}`,
    `last seq: ${snapshot?.lastSeq ?? "none"}`,
    `last result: ${snapshot?.lastResultOk == null ? "none" : snapshot.lastResultOk ? "ok" : "error"}`,
    `stale working fallback: ${snapshot?.staleWorkingMs ?? "unknown"}ms`,
    `post-tool idle fallback: ${snapshot?.postToolIdleMs ?? "unknown"}ms`,
    `tool watchdog: ${snapshot?.toolWatchdogMs ?? "unknown"}ms`,
    snapshot?.lastError ? `last error: ${snapshot.lastError}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseDurationMs(
  value: string | undefined,
  defaultValue: number,
  options: { allowZero: boolean },
): number {
  if (value == null || value.trim() === "") return defaultValue;

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return defaultValue;
  if (parsed < 0) return defaultValue;
  if (!options.allowZero && parsed === 0) return defaultValue;
  return parsed;
}
