import {
  normalizeLabel,
  validTtl,
  type HerdrResult,
  type MetadataInput,
} from "./herdr-client";

export type MetadataClient = {
  laneKey: string;
  reportMetadata(input: MetadataInput): Promise<HerdrResult>;
};
export type ScopedContext = {
  agent?: { id?: string | null; name?: string | null };
  conversation?: { id?: string | null };
  sessionId?: string | null;
};
export type Observation = {
  agentId?: string | null;
  agentName?: string | null;
  conversationId?: string | null;
  toolCallId?: string | null;
  toolName?: string;
  status?: string;
  error?: unknown;
};
export type EventName =
  | "conversation_open"
  | "conversation_close"
  | "turn_start"
  | "turn_end"
  | "tool_start"
  | "tool_end"
  | "llm_start"
  | "llm_end";
type Lane = { owner: symbol; tail: Promise<void> };
type Registry = { lanes: Map<string, Lane>; seq: number };
// Only transport ordering survives cache-busted mod reloads, not reporter/context state.
// Two fixed server sources; no per-activation source accumulation or name heartbeat.
const registryKey = Symbol.for("letta-herdr-mod.metadata-lanes.v1");
const host = globalThis as typeof globalThis & { [registryKey]?: Registry };
const registry = (host[registryKey] ??= { lanes: new Map(), seq: 0 });
export class MetadataReporter {
  readonly activity: boolean;
  readonly ttlMs: number;
  private readonly override: string | undefined;
  private readonly owner = Symbol();
  private readonly lane: Lane;
  private generation = 0;
  private disposed = false;
  private closed = false;
  private agentId: string | undefined;
  private conversationId: string | undefined;
  private expectedName: string | undefined;
  private acknowledgedName: string | undefined;
  private nameKnown = false;
  private nameRevision = 0;
  private acknowledgedNameRevision = 0;
  private tools = new Map<string, string>();
  private lastAck: boolean | undefined;
  private lastError: string | undefined;
  constructor(
    private readonly client: MetadataClient,
    options: {
      displayAgent?: string | undefined;
      activity?: boolean;
      ttlMs?: number;
    } = {},
  ) {
    this.override = normalizeLabel(options.displayAgent);
    this.activity = options.activity ?? false;
    this.ttlMs = validTtl(options.ttlMs ?? 30000)
      ? (options.ttlMs ?? 30000)
      : 30000;
    this.lane = registry.lanes.get(client.laneKey) ?? {
      owner: this.owner,
      tail: Promise.resolve(),
    };
    this.lane.owner = this.owner;
    registry.lanes.set(client.laneKey, this.lane);
    // Also clear stale detail when the replacement disables activity.
    this.clearOwned();
  }
  snapshot() {
    return {
      expectedName: this.expectedName,
      agentId: this.agentId,
      conversationId: this.conversationId,
      activity: this.activity,
      ttlMs: this.ttlMs,
      lastAck: this.lastAck,
      lastError: this.lastError,
    };
  }
  flush(): Promise<void> {
    return this.lane.tail;
  }
  observe(
    kind: EventName,
    event: Observation = {},
    ctx: ScopedContext = {},
  ): Promise<void> {
    if (this.disposed || this.lane.owner !== this.owner) return this.flush();
    const agentId = event.agentId ?? ctx.agent?.id ?? this.agentId;
    const conversationId =
      event.conversationId ??
      ctx.conversation?.id ??
      ctx.sessionId ??
      this.conversationId;
    const changed =
      agentId !== this.agentId || conversationId !== this.conversationId;
    // Completion callbacks from an old scope must not reopen or rename that scope.
    if (
      (kind.endsWith("_end") || kind === "conversation_close") &&
      changed &&
      (this.agentId || this.conversationId)
    )
      return this.flush();
    if (this.closed && kind !== "conversation_open" && kind !== "turn_start")
      return this.flush();
    if (kind === "conversation_close") {
      this.closed = true;
      this.generation++;
      this.tools.clear();
      this.expectedName = undefined;
      this.nameKnown = false;
      this.clearOwned();
      return this.flush();
    }
    this.closed = false;
    if (changed) {
      this.generation++;
      this.agentId = agentId;
      this.conversationId = conversationId;
      this.tools.clear();
      this.expectedName = undefined;
      this.nameKnown = false;
      this.enqueue({ kind: "activity", clear: true }, false);
    }
    const ctxConversation = ctx.conversation?.id ?? ctx.sessionId;
    const matches =
      (!agentId || ctx.agent?.id === agentId) &&
      (!conversationId || ctxConversation === conversationId);
    const scopedName =
      kind === "conversation_open"
        ? (normalizeLabel(event.agentName) ??
          (matches ? normalizeLabel(ctx.agent?.name) : undefined))
        : matches
          ? normalizeLabel(ctx.agent?.name)
          : undefined;
    this.expectedName =
      this.override ?? scopedName ?? (changed ? undefined : this.expectedName);
    const name = this.expectedName;
    if (
      !this.nameKnown ||
      name !== this.acknowledgedName ||
      this.nameRevision !== this.acknowledgedNameRevision
    ) {
      // A prior acknowledgement cannot deduplicate against a newer pending write.
      const revision = ++this.nameRevision;
      this.enqueue(
        name
          ? { kind: "name", displayAgent: name }
          : { kind: "name", clear: true },
        true,
        () => {
          this.acknowledgedName = name;
          this.acknowledgedNameRevision = revision;
          this.nameKnown = true;
        },
      );
    }
    if (!this.activity) return this.flush();
    if (kind === "turn_end" || (kind === "llm_end" && event.error != null)) {
      this.tools.clear();
      this.enqueue({ kind: "activity", clear: true });
    } else if (
      ["turn_start", "tool_start", "tool_end", "llm_start"].includes(kind)
    ) {
      if (kind === "turn_start") this.tools.clear();
      if (kind === "tool_start" && event.toolCallId)
        this.tools.set(
          event.toolCallId,
          normalizeLabel(event.toolName) ?? "tool",
        );
      if (kind === "tool_end" && event.toolCallId)
        this.tools.delete(event.toolCallId);
      const working =
        this.tools.size > 1
          ? `tools:${this.tools.size}`
          : this.tools.size === 1
            ? `tool:${this.tools.values().next().value}`
            : kind === "tool_start"
              ? `tool:${normalizeLabel(event.toolName) ?? "tool"}`
              : kind === "llm_start"
                ? "thinking"
                : "processing";
      this.enqueue({ kind: "activity", working, ttlMs: this.ttlMs });
    }
    return this.flush();
  }
  dispose(): Promise<void> {
    if (this.disposed) return this.flush();
    this.disposed = true;
    this.generation++;
    this.tools.clear();
    if (this.lane.owner !== this.owner) return this.flush();
    this.clearOwned();
    const tail = this.lane.tail;
    void tail.then(() => {
      if (this.lane.owner === this.owner && this.lane.tail === tail)
        registry.lanes.delete(this.client.laneKey);
    });
    return tail;
  }
  private clearOwned() {
    this.enqueue({ kind: "activity", clear: true }, false);
    this.enqueue({ kind: "name", clear: true }, false);
  }
  private enqueue(input: WithoutSeq, contextBound = true, onAck?: () => void) {
    if (this.lane.owner !== this.owner) return;
    const generation = this.generation;
    registry.seq = Math.max(registry.seq + 1, Date.now() * 1000);
    const payload = { ...input, seq: registry.seq } as MetadataInput;
    this.lane.tail = this.lane.tail.then(async () => {
      if (
        this.lane.owner !== this.owner ||
        (contextBound && (this.disposed || generation !== this.generation))
      )
        return;
      let result: HerdrResult;
      try {
        result = await this.client.reportMetadata(payload);
      } catch {
        result = { ok: false, error: "Herdr transport failed" };
      }
      if (this.lane.owner !== this.owner) return;
      this.lastAck = result.ok;
      if (!result.ok) this.lastError = result.error;
      if (result.ok && generation === this.generation) onAck?.();
    });
  }
}
type WithoutSeq = MetadataInput extends infer T
  ? T extends MetadataInput
    ? Omit<T, "seq">
    : never
  : never;
