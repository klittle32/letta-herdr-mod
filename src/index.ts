import {
  HerdrClient,
  normalizeLabel,
  resolveHerdrEnv,
  validTtl,
  type ResolvedHerdrEnv,
} from "./herdr-client";
import {
  MetadataReporter,
  type EventName,
  type Observation,
  type ScopedContext,
} from "./metadata-reporter";

type Dispose = () => void;
type LettaModApi = {
  capabilities?: {
    events?: Partial<Record<"lifecycle" | "turns" | "tools" | "llm", boolean>>;
    commands?: boolean;
  };
  events?: {
    on(
      name: string,
      handler: (event: Observation, ctx?: ScopedContext) => void,
    ): Dispose;
  };
  commands?: {
    register(command: {
      id: string;
      description: string;
      showInTranscript: boolean;
      run(ctx: ScopedContext): Promise<{ type: "output"; output: string }>;
    }): Dispose;
  };
  diagnostics?: {
    report(diagnostic: { message: string; severity: "warning" }): void;
  };
};
type ReporterBundle = {
  env: ResolvedHerdrEnv;
  client?: HerdrClient;
  reporter?: MetadataReporter;
  warnings: string[];
};
const eventGroups = {
  lifecycle: ["conversation_open", "conversation_close"],
  turns: ["turn_start", "turn_end"],
  tools: ["tool_start", "tool_end"],
  llm: ["llm_start", "llm_end"],
} as const;
export default function activate(letta: LettaModApi): Dispose {
  const bundle = createReporterFromEnv(process.env);
  const disposers: Dispose[] = [];
  for (const group of Object.keys(
    eventGroups,
  ) as (keyof typeof eventGroups)[]) {
    if (letta.capabilities?.events?.[group] && letta.events) {
      for (const name of eventGroups[group])
        disposers.push(
          letta.events.on(name, (event, ctx) => {
            void bundle.reporter?.observe(name as EventName, event, ctx);
          }),
        );
    } else
      bundle.warnings.push(
        `${group} events unavailable; related metadata cannot refresh`,
      );
  }
  // Setup warnings are emitted once per activation, not once per event.
  if (bundle.warnings.length)
    letta.diagnostics?.report({
      message: bundle.warnings.join("; "),
      severity: "warning",
    });
  if (letta.capabilities?.commands && letta.commands)
    disposers.push(
      letta.commands.register({
        id: "herdr-status",
        description: "Read Herdr pane identity and presentation diagnostics.",
        showInTranscript: false,
        async run(ctx) {
          return { type: "output", output: await formatStatus(bundle, ctx) };
        },
      }),
    );
  return () => {
    for (const dispose of disposers.reverse()) dispose();
    void bundle.reporter?.dispose();
  };
}
export function parseActivityTtl(value: string | undefined): number {
  const parsed = Number(value);
  return validTtl(parsed) ? parsed : 30000;
}
export function createReporterFromEnv(
  env: Record<string, string | undefined>,
): ReporterBundle {
  const retired = [
    "AGENT",
    "STATE",
    "IDLE_DELAY_MS",
    "STALE_WORKING_MS",
    "POST_TOOL_IDLE_MS",
    "TOOL_WATCHDOG_MS",
    "APPROVAL_BLOCKED",
  ].filter((key) => env[`LETTA_HERDR_${key}`] !== undefined);
  const warnings = retired.length
    ? [
        `retired settings ignored: ${retired.map((key) => `LETTA_HERDR_${key}`).join(", ")}`,
      ]
    : [];
  const resolved =
    env.LETTA_CODE_AGENT_ROLE === "subagent"
      ? {
          enabled: false as const,
          reason: "subagent inherits the parent pane; metadata disabled",
        }
      : resolveHerdrEnv(env);
  if (!resolved.enabled) return { env: resolved, warnings };
  try {
    const client = new HerdrClient({
      env: resolved,
      source: env.LETTA_HERDR_SOURCE,
    });
    const reporter = new MetadataReporter(client, {
      displayAgent: env.LETTA_HERDR_DISPLAY_AGENT,
      activity: env.LETTA_HERDR_ACTIVITY_DETAIL === "1",
      ttlMs: parseActivityTtl(env.LETTA_HERDR_ACTIVITY_TTL_MS),
    });
    return { env: resolved, warnings, client, reporter };
  } catch {
    return {
      env: { enabled: false, reason: "invalid Herdr metadata configuration" },
      warnings,
    };
  }
}
export async function formatStatus(
  bundle: ReporterBundle,
  ctx: ScopedContext,
): Promise<string> {
  if (!bundle.env.enabled)
    return `letta-herdr-mod: disabled\nreason: ${bundle.env.reason}`;
  const snapshot = bundle.reporter?.snapshot();
  const result = await bundle.client!.getPane();
  const raw = result.ok ? result.response.pane : undefined;
  const pane =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const valid =
    pane?.pane_id === bundle.env.paneId &&
    typeof pane.agent_status === "string";
  const session =
    valid && pane.agent_session && typeof pane.agent_session === "object"
      ? (pane.agent_session as Record<string, unknown>)
      : undefined;
  const conversationId = ctx.conversation?.id ?? ctx.sessionId;
  const expectedSession =
    conversationId === "default"
      ? ctx.agent?.id
        ? `default:${ctx.agent.id}`
        : undefined
      : conversationId;
  const observedSession =
    typeof session?.value === "string" ? session.value : undefined;
  const safe = (value: unknown) => normalizeLabel(value) ?? "none";
  return [
    "letta-herdr-mod: enabled (metadata only)",
    `pane: ${bundle.env.paneId}`,
    `expected name (local intent): ${safe(snapshot?.expectedName)}`,
    `last write acknowledgement: ${snapshot?.lastAck == null ? "none" : snapshot.lastAck ? "ok (not proof of application)" : "failed"}`,
    valid
      ? `read-back display: ${safe(pane.display_agent)}; semantic state: ${safe(pane.agent_status)}`
      : `read-back unavailable: ${result.ok ? "invalid pane read-back" : result.error}`,
    `session reference: ${safe(observedSession)}; source: ${safe(session?.source)}; agent: ${safe(session?.agent)}`,
    !observedSession
      ? "warning: native session identity absent or unreadable"
      : session?.source !== "herdr:letta" ||
          session?.agent !== "letta" ||
          session?.kind !== "id"
        ? "warning: session reference is not native Letta"
        : expectedSession && expectedSession !== observedSession
          ? "warning: native session identity mismatch"
          : undefined,
    `activity: ${snapshot?.activity ? "on" : "off"}; TTL: ${snapshot?.ttlMs ?? 30000}ms`,
    snapshot?.lastError ? `last write error: ${snapshot.lastError}` : undefined,
    ...bundle.warnings,
    "Read-back text is not proof of metadata source ownership.",
  ]
    .filter(Boolean)
    .join("\n");
}
