import type {
  HerdrAgentState,
  HerdrResult,
  ClearAgentAuthorityInput,
  ReleaseAgentInput,
  ReportAgentInput,
  ReportMetadataInput,
} from "./herdr-client";

export type HerdrReporterClient = {
  reportAgent(input: ReportAgentInput): Promise<HerdrResult>;
  reportMetadata(input: ReportMetadataInput): Promise<HerdrResult>;
  clearAgentAuthority(input: ClearAgentAuthorityInput): Promise<HerdrResult>;
  releaseAgent(input: ReleaseAgentInput): Promise<HerdrResult>;
};

export type StateReporterOptions = {
  now?: (() => number) | undefined;
  idleDelayMs?: number | undefined;
  staleWorkingMs?: number | undefined;
  postToolIdleMs?: number | undefined;
  toolWatchdogMs?: number | undefined;
  reportApprovalBlocked?: boolean | undefined;
};

export const DEFAULT_IDLE_DELAY_MS = 250;
export const DEFAULT_STALE_WORKING_MS = 300_000;
export const DEFAULT_POST_TOOL_IDLE_MS = 0;
export const DEFAULT_TOOL_WATCHDOG_MS = 0;

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
  staleWorkingMs: number;
  postToolIdleMs: number;
  toolWatchdogMs: number;
};

export class HerdrStateReporter {
  private readonly now: () => number;
  private readonly idleDelayMs: number;
  private readonly staleWorkingMs: number;
  private readonly postToolIdleMs: number;
  private readonly toolWatchdogMs: number;
  private readonly reportApprovalBlocked: boolean;
  private seqCounter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private staleWorkingTimer: ReturnType<typeof setTimeout> | undefined;
  private toolWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private lastKey: string | undefined;
  private lastConversationId: string | null = null;
  private lastState: HerdrAgentState | null = null;
  private lastCustomStatus: string | null = null;
  private lastSeq: number | null = null;
  private lastError: string | null = null;
  private lastResultOk: boolean | null = null;
  private displayAgent: string | undefined;

  constructor(
    private readonly client: HerdrReporterClient,
    options: StateReporterOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
    this.staleWorkingMs = options.staleWorkingMs ?? DEFAULT_STALE_WORKING_MS;
    this.postToolIdleMs = options.postToolIdleMs ?? DEFAULT_POST_TOOL_IDLE_MS;
    this.toolWatchdogMs = options.toolWatchdogMs ?? DEFAULT_TOOL_WATCHDOG_MS;
    this.reportApprovalBlocked = options.reportApprovalBlocked ?? false;
  }

  setDisplayAgent(displayAgent: string | undefined): void {
    const normalized = normalizeDisplayAgent(displayAgent);
    if (normalized) this.displayAgent = normalized;
  }

  async onConversationOpen(event: ConversationEvent): Promise<void> {
    await this.report("idle", "ready", event.conversationId ?? undefined);
  }

  async onTurnStart(event: ConversationEvent): Promise<void> {
    await this.reportWorking("turn", event.conversationId ?? undefined);
  }

  onTurnEnd(event: ConversationEvent): void {
    this.cancelFallbackTimers();
    this.scheduleIdle(event.conversationId ?? undefined);
  }

  async onLlmStart(event: ConversationEvent): Promise<void> {
    await this.reportWorking("thinking", event.conversationId ?? undefined);
  }

  async onLlmEnd(event: LlmEndEvent): Promise<void> {
    if (event.error) {
      await this.report("blocked", "llm error", event.conversationId ?? undefined, formatLlmErrorMessage(event.error));
      return;
    }

    const stopReason = String(event.stopReason ?? "").toLowerCase();
    if (isIntermediateLlmStop(stopReason)) {
      this.scheduleStaleWorking(event.conversationId ?? undefined);
      return;
    }

    this.cancelFallbackTimers();
    this.scheduleIdle(event.conversationId ?? undefined);
  }

  async onToolStart(event: ToolStartEvent): Promise<void> {
    // Tool events are status detail within a turn. The durable lifecycle
    // boundary is turn_start/turn_end, mirroring Herdr's built-in integrations
    // that track agent/session start and end rather than individual tools.
    this.cancelStaleWorking();
    this.cancelToolWatchdog();
    await this.report("working", `tool:${event.toolName}`, event.conversationId ?? undefined);
    this.scheduleToolWatchdog(event.conversationId ?? undefined);
  }

  async onToolEnd(event: ConversationEvent): Promise<void> {
    // After a tool returns, Letta usually hands the result back to the model to
    // decide whether to call another tool or answer. Semantically that is still
    // working; do not flicker to idle between tool calls. turn_end is the
    // primary completion event; postToolIdleMs is an opt-in fallback for hosts
    // that lack turn_end.
    this.cancelToolWatchdog();
    await this.report("working", "thinking", event.conversationId ?? undefined);
    this.scheduleIdle(event.conversationId ?? undefined, this.postToolIdleMs);
  }

  async onPermissionCheck(event: PermissionCheckEvent): Promise<void> {
    if (!this.reportApprovalBlocked) return;
    if (event.phase !== "approval") return;
    await this.report("blocked", "approval", event.conversationId ?? undefined, "Approval required");
  }

  async report(
    state: HerdrAgentState,
    customStatus?: string | undefined,
    conversationId?: string | null | undefined,
    message?: string | undefined,
  ): Promise<HerdrResult | undefined> {
    this.cancelIdle();
    if (state !== "working") {
      this.cancelFallbackTimers();
    }
    const normalizedConversationId = conversationId ?? this.lastConversationId ?? undefined;
    const key = JSON.stringify([state, customStatus ?? null, normalizedConversationId ?? null]);
    if (key === this.lastKey) {
      return undefined;
    }

    const seq = this.nextSeq();
    const result = await this.client.reportAgent({
      state,
      customStatus,
      message,
      seq,
      agentSessionId: normalizedConversationId,
    });

    const metadataResult = customStatus
      ? await this.client.reportMetadata({
          customStatus,
          displayAgent: this.displayAgent,
          stateLabels: { [state]: customStatus },
          seq,
        })
      : undefined;

    const reportAccepted = result.ok || result.skipped;
    const metadataAccepted = metadataResult == null || metadataResult.ok || metadataResult.skipped;
    this.recordResult(reportAccepted ? (metadataResult ?? result) : result);
    if (reportAccepted && metadataAccepted) {
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
    this.cancelFallbackTimers();
    const normalizedConversationId = conversationId ?? this.lastConversationId ?? undefined;
    const seq = this.nextSeq();
    const metadataResult = await this.client.reportMetadata({
      clearSummary: true,
      clearStateLabels: true,
      clearDisplayAgent: true,
      seq,
    });
    const result = await this.client.releaseAgent({
      seq,
      agentSessionId: normalizedConversationId,
    });
    this.recordResult(result.ok ? metadataResult : result);
    this.lastKey = undefined;
    return result;
  }

  async clearAuthority(): Promise<HerdrResult> {
    this.cancelIdle();
    this.cancelFallbackTimers();
    const seq = this.nextSeq();
    const metadataResult = await this.client.reportMetadata({
      clearSummary: true,
      clearStateLabels: true,
      clearDisplayAgent: true,
      seq,
    });
    const result = await this.client.clearAgentAuthority({ seq });
    this.recordResult(result.ok ? metadataResult : result);
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
      staleWorkingMs: this.staleWorkingMs,
      postToolIdleMs: this.postToolIdleMs,
      toolWatchdogMs: this.toolWatchdogMs,
    };
  }

  private async reportWorking(customStatus: string, conversationId?: string | null | undefined): Promise<void> {
    await this.report("working", customStatus, conversationId);
    this.scheduleStaleWorking(conversationId);
  }

  private scheduleIdle(conversationId?: string | null | undefined, delayMs = this.idleDelayMs): void {
    this.cancelIdle();
    if (delayMs <= 0) return;
    const normalizedConversationId = conversationId ?? this.lastConversationId ?? undefined;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.report("idle", "ready", normalizedConversationId);
    }, delayMs);
  }

  private scheduleStaleWorking(conversationId?: string | null | undefined): void {
    this.cancelStaleWorking();
    if (this.staleWorkingMs <= 0) return;

    const normalizedConversationId = conversationId ?? this.lastConversationId ?? undefined;
    this.staleWorkingTimer = setTimeout(() => {
      this.staleWorkingTimer = undefined;
      void this.report("idle", "ready", normalizedConversationId);
    }, this.staleWorkingMs);
  }

  private scheduleToolWatchdog(conversationId?: string | null | undefined): void {
    this.cancelToolWatchdog();
    if (this.toolWatchdogMs <= 0) return;

    const normalizedConversationId = conversationId ?? this.lastConversationId ?? undefined;
    this.toolWatchdogTimer = setTimeout(() => {
      this.toolWatchdogTimer = undefined;
      void this.report("idle", "ready", normalizedConversationId);
    }, this.toolWatchdogMs);
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private cancelStaleWorking(): void {
    if (this.staleWorkingTimer) {
      clearTimeout(this.staleWorkingTimer);
      this.staleWorkingTimer = undefined;
    }
  }

  private cancelToolWatchdog(): void {
    if (this.toolWatchdogTimer) {
      clearTimeout(this.toolWatchdogTimer);
      this.toolWatchdogTimer = undefined;
    }
  }

  private cancelFallbackTimers(): void {
    this.cancelStaleWorking();
    this.cancelToolWatchdog();
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

function isIntermediateLlmStop(stopReason: string): boolean {
  return stopReason.includes("tool") || stopReason.includes("approval");
}

function formatLlmErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? `LLM error: ${normalized.slice(0, 160)}` : "LLM error";
}

function normalizeDisplayAgent(displayAgent: string | undefined): string | undefined {
  if (displayAgent == null) return undefined;
  const normalized = displayAgent.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized || undefined;
}
