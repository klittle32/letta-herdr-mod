import type { HerdrAgentState, HerdrResult, ReleaseAgentInput, ReportAgentInput } from "./herdr-client";

export type HerdrReporterClient = {
  reportAgent(input: ReportAgentInput): Promise<HerdrResult>;
  releaseAgent(input: ReleaseAgentInput): Promise<HerdrResult>;
};

export type StateReporterOptions = {
  now?: (() => number) | undefined;
  idleDelayMs?: number | undefined;
  reportApprovalBlocked?: boolean | undefined;
};

export type ConversationEvent = {
  conversationId?: string | null | undefined;
};

export type ToolStartEvent = ConversationEvent & {
  toolName: string;
};

export type LlmEndEvent = ConversationEvent & {
  stopReason?: string | null | undefined;
  error?: unknown;
};

export type PermissionCheckEvent = ConversationEvent & {
  phase?: string | null | undefined;
};

export type ReporterSnapshot = {
  enabled: true;
  lastState: HerdrAgentState | null;
  lastCustomStatus: string | null;
  lastConversationId: string | null;
  lastSeq: number | null;
  lastError: string | null;
  lastResultOk: boolean | null;
};

export class HerdrStateReporter {
  private readonly now: () => number;
  private readonly idleDelayMs: number;
  private readonly reportApprovalBlocked: boolean;
  private seqCounter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastKey: string | undefined;
  private lastConversationId: string | null = null;
  private lastState: HerdrAgentState | null = null;
  private lastCustomStatus: string | null = null;
  private lastSeq: number | null = null;
  private lastError: string | null = null;
  private lastResultOk: boolean | null = null;

  constructor(
    private readonly client: HerdrReporterClient,
    options: StateReporterOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.idleDelayMs = options.idleDelayMs ?? 150;
    this.reportApprovalBlocked = options.reportApprovalBlocked ?? false;
  }

  async onConversationOpen(event: ConversationEvent): Promise<void> {
    await this.report("idle", "ready", event.conversationId ?? undefined);
  }

  async onTurnStart(event: ConversationEvent): Promise<void> {
    await this.report("working", "turn", event.conversationId ?? undefined);
  }

  async onLlmStart(event: ConversationEvent): Promise<void> {
    await this.report("working", "thinking", event.conversationId ?? undefined);
  }

  async onLlmEnd(event: LlmEndEvent): Promise<void> {
    if (event.error) {
      await this.report("blocked", "llm error", event.conversationId ?? undefined);
      return;
    }

    const stopReason = String(event.stopReason ?? "").toLowerCase();
    if (stopReason.includes("tool")) {
      return;
    }

    this.scheduleIdle(event.conversationId ?? undefined);
  }

  async onToolStart(event: ToolStartEvent): Promise<void> {
    await this.report("working", `tool:${event.toolName}`, event.conversationId ?? undefined);
  }

  onToolEnd(event: ConversationEvent): void {
    this.scheduleIdle(event.conversationId ?? undefined);
  }

  async onPermissionCheck(event: PermissionCheckEvent): Promise<void> {
    if (!this.reportApprovalBlocked) return;
    if (event.phase !== "approval") return;
    await this.report("blocked", "approval", event.conversationId ?? undefined);
  }

  async report(
    state: HerdrAgentState,
    customStatus?: string | undefined,
    conversationId?: string | null | undefined,
  ): Promise<HerdrResult | undefined> {
    this.cancelIdle();
    const normalizedConversationId = conversationId ?? this.lastConversationId ?? undefined;
    const key = JSON.stringify([state, customStatus ?? null, normalizedConversationId ?? null]);
    if (key === this.lastKey) {
      return undefined;
    }

    const seq = this.nextSeq();
    const result = await this.client.reportAgent({
      state,
      customStatus,
      seq,
      agentSessionId: normalizedConversationId,
    });

    this.recordResult(result);
    if (result.ok || result.skipped) {
      this.lastKey = key;
      this.lastConversationId = normalizedConversationId ?? null;
      this.lastState = state;
      this.lastCustomStatus = customStatus ?? null;
      this.lastSeq = seq;
    }
    return result;
  }

  async release(conversationId?: string | null | undefined): Promise<HerdrResult> {
    this.cancelIdle();
    const normalizedConversationId = conversationId ?? this.lastConversationId ?? undefined;
    const result = await this.client.releaseAgent({
      seq: this.nextSeq(),
      agentSessionId: normalizedConversationId,
    });
    this.recordResult(result);
    this.lastKey = undefined;
    return result;
  }

  snapshot(): ReporterSnapshot {
    return {
      enabled: true,
      lastState: this.lastState,
      lastCustomStatus: this.lastCustomStatus,
      lastConversationId: this.lastConversationId,
      lastSeq: this.lastSeq,
      lastError: this.lastError,
      lastResultOk: this.lastResultOk,
    };
  }

  private scheduleIdle(conversationId?: string | null | undefined): void {
    this.cancelIdle();
    const normalizedConversationId = conversationId ?? this.lastConversationId ?? undefined;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.report("idle", "ready", normalizedConversationId);
    }, this.idleDelayMs);
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private nextSeq(): number {
    this.seqCounter += 1;
    return Math.floor(this.now()) * 1_000 + this.seqCounter;
  }

  private recordResult(result: HerdrResult): void {
    this.lastResultOk = result.ok;
    this.lastError = result.ok ? null : result.error ?? result.reason ?? "Herdr report failed";
  }
}
