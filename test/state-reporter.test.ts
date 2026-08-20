import { describe, expect, test } from "bun:test";
import { HerdrStateReporter } from "../src/state-reporter";
import type {
  HerdrAgentState,
  HerdrResult,
  ReleaseAgentInput,
  ReportAgentInput,
  ClearAgentAuthorityInput,
  ReportMetadataInput,
} from "../src/herdr-client";

class FakeClient {
  reports: ReportAgentInput[] = [];
  metadata: ReportMetadataInput[] = [];
  clears: ClearAgentAuthorityInput[] = [];
  releases: ReleaseAgentInput[] = [];

  async reportAgent(input: ReportAgentInput): Promise<HerdrResult> {
    this.reports.push({ ...input });
    return { ok: true };
  }

  async reportMetadata(input: ReportMetadataInput): Promise<HerdrResult> {
    this.metadata.push({ ...input });
    return { ok: true };
  }

  async releaseAgent(input: ReleaseAgentInput): Promise<HerdrResult> {
    this.releases.push({ ...input });
    return { ok: true };
  }

  async clearAgentAuthority(input: ClearAgentAuthorityInput): Promise<HerdrResult> {
    this.clears.push({ ...input });
    return { ok: true };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("HerdrStateReporter", () => {
  test("reports turn start as working", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 10, idleDelayMs: 20 });

    await reporter.onTurnStart({ conversationId: "conv-1" });

    expect(client.reports).toHaveLength(1);
    expect(client.reports[0]).toMatchObject({
      state: "working" satisfies HerdrAgentState,
      customStatus: "turn",
      seq: 10_001,
      agentSessionId: "conv-1",
    });
    expect(client.metadata[0]).toMatchObject({
      customStatus: "turn",
      stateLabels: { working: "turn" },
      seq: 10_001,
    });
  });

  test("reports display labels through metadata, not lifecycle payloads", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 11, idleDelayMs: 20 });
    reporter.setDisplayAgent("Johnny5");

    await reporter.onToolStart({ conversationId: "conv-label", toolName: "exec_command" });

    expect(client.reports[0]).toMatchObject({
      state: "working",
      customStatus: "tool:exec_command",
      seq: 11_001,
    });
    expect(client.metadata).toEqual([
      {
        customStatus: "tool:exec_command",
        displayAgent: "Johnny5",
        stateLabels: { working: "tool:exec_command" },
        seq: 11_001,
      },
    ]);
  });

  test("llm end schedules idle and cancels if a tool starts", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 20, idleDelayMs: 25 });

    await reporter.onLlmStart({ conversationId: "conv-2" });
    reporter.onLlmEnd({ conversationId: "conv-2", stopReason: "stop" });
    await reporter.onToolStart({ conversationId: "conv-2", toolName: "exec_command" });
    await sleep(35);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "thinking"],
      ["working", "tool:exec_command"],
    ]);
  });

  test("llm end reports idle after delay", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 30, idleDelayMs: 10 });

    await reporter.onLlmStart({ conversationId: "conv-3" });
    reporter.onLlmEnd({ conversationId: "conv-3", stopReason: "stop" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "thinking"],
      ["idle", "ready"],
    ]);
  });

  test("llm end cancels stale-working fallback before scheduling idle", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, {
      now: () => 34,
      idleDelayMs: 50,
      staleWorkingMs: 10,
    });

    await reporter.onLlmStart({ conversationId: "conv-llm-terminal" });
    reporter.onLlmEnd({ conversationId: "conv-llm-terminal", stopReason: "stop" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "thinking"],
    ]);

    await sleep(40);
    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "thinking"],
      ["idle", "ready"],
    ]);
  });

  test("llm approval stops stay working until the turn continues", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 35, idleDelayMs: 10 });

    await reporter.onLlmStart({ conversationId: "conv-approval" });
    reporter.onLlmEnd({ conversationId: "conv-approval", stopReason: "requires_approval" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "thinking"],
    ]);
  });

  test("llm errors report blocked", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 40, idleDelayMs: 10 });

    await reporter.onLlmEnd({ conversationId: "conv-4", stopReason: "error", error: new Error("boom") });

    expect(client.reports).toHaveLength(1);
    expect(client.reports[0]).toMatchObject({
      state: "blocked",
      customStatus: "llm error",
      message: "LLM error: boom",
    });
  });

  test("turn start has stale-working fallback for hosts without llm_end", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 45, staleWorkingMs: 10 });

    await reporter.onTurnStart({ conversationId: "conv-stale" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "turn"],
      ["idle", "ready"],
    ]);
  });

  test("turn end is the primary idle signal", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 45, idleDelayMs: 10, staleWorkingMs: 50 });

    await reporter.onTurnStart({ conversationId: "conv-turn-end" });
    await reporter.onToolStart({ conversationId: "conv-turn-end", toolName: "exec_command" });
    reporter.onTurnEnd({ conversationId: "conv-turn-end" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "turn"],
      ["working", "tool:exec_command"],
      ["idle", "ready"],
    ]);
  });

  test("turn end cancels stale-working fallback before debounce", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 45, idleDelayMs: 50, staleWorkingMs: 10 });

    await reporter.onTurnStart({ conversationId: "conv-turn-end-cancels-stale" });
    reporter.onTurnEnd({ conversationId: "conv-turn-end-cancels-stale" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "turn"],
    ]);

    await sleep(40);
    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "turn"],
      ["idle", "ready"],
    ]);
  });

  test("stale-working fallback can be disabled", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 46, staleWorkingMs: 0 });

    await reporter.onTurnStart({ conversationId: "conv-stale-off" });
    await sleep(15);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([["working", "turn"]]);
  });

  test("tool start clears stale-working fallback and optionally arms tool watchdog", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 47, staleWorkingMs: 10, toolWatchdogMs: 10 });

    await reporter.onTurnStart({ conversationId: "conv-tool-long" });
    await reporter.onToolStart({ conversationId: "conv-tool-long", toolName: "exec_command" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "turn"],
      ["working", "tool:exec_command"],
      ["idle", "ready"],
    ]);
  });

  test("tool watchdog can be disabled", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 47, toolWatchdogMs: 0 });

    await reporter.onToolStart({ conversationId: "conv-tool-watchdog-off", toolName: "exec_command" });
    await sleep(15);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "tool:exec_command"],
    ]);
  });

  test("tool watchdog fallback handles missing tool_end", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 48, toolWatchdogMs: 10 });

    await reporter.onToolStart({ conversationId: "conv-tool-missing-end", toolName: "exec_command" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "tool:exec_command"],
      ["idle", "ready"],
    ]);
  });

  test("tool end stays working while the model processes tool output", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 49, postToolIdleMs: 20 });

    await reporter.onToolStart({ conversationId: "conv-tool-gap", toolName: "exec_command" });
    await reporter.onToolEnd({ conversationId: "conv-tool-gap" });
    await sleep(10);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "tool:exec_command"],
      ["working", "thinking"],
    ]);
  });

  test("tool end eventually falls back to idle if no completion event arrives", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 50, postToolIdleMs: 10 });

    await reporter.onToolEnd({ conversationId: "conv-tool-final" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "thinking"],
      ["idle", "ready"],
    ]);
  });

  test("post-tool idle fallback is cancelled by the next tool", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 51, postToolIdleMs: 10, toolWatchdogMs: 0 });

    await reporter.onToolEnd({ conversationId: "conv-tool-chain" });
    await reporter.onToolStart({ conversationId: "conv-tool-chain", toolName: "Read" });
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "thinking"],
      ["working", "tool:Read"],
    ]);
  });

  test("deduplicates identical reports but increments seq for changes", async () => {
    let now = 52;
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => now, idleDelayMs: 10 });

    await reporter.report("working", "thinking", "conv-5");
    await reporter.report("working", "thinking", "conv-5");
    now = 53;
    await reporter.report("working", "tool:Read", "conv-5");

    expect(client.reports).toHaveLength(2);
    expect(client.reports.map((r) => r.seq)).toEqual([52_001, 53_002]);
  });

  test("release clears timers and releases authority", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 60, idleDelayMs: 50 });

    reporter.onLlmEnd({ conversationId: "conv-6", stopReason: "stop" });
    await reporter.release("conv-6");
    await sleep(70);

    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toMatchObject({ seq: 60_001, agentSessionId: "conv-6" });
    expect(client.metadata[0]).toMatchObject({ clearSummary: true, clearStateLabels: true, seq: 60_001 });
    expect(client.reports).toHaveLength(0);
  });

  test("release clears stale-working fallback", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 61, staleWorkingMs: 10 });

    await reporter.onTurnStart({ conversationId: "conv-release-stale" });
    await reporter.release("conv-release-stale");
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "turn"],
    ]);
    expect(client.releases).toHaveLength(1);
  });

  test("release clears tool watchdog fallback", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 62, toolWatchdogMs: 10 });

    await reporter.onToolStart({ conversationId: "conv-release-watchdog", toolName: "exec_command" });
    await reporter.release("conv-release-watchdog");
    await sleep(25);

    expect(client.reports.map((r) => [r.state, r.customStatus])).toEqual([
      ["working", "tool:exec_command"],
    ]);
    expect(client.releases).toHaveLength(1);
  });

  test("approval blocked reporting is opt-in", async () => {
    const offClient = new FakeClient();
    const off = new HerdrStateReporter(offClient, { now: () => 70, reportApprovalBlocked: false });
    await off.onPermissionCheck({ conversationId: "conv-7", phase: "approval" });
    expect(offClient.reports).toHaveLength(0);

    const onClient = new FakeClient();
    const on = new HerdrStateReporter(onClient, { now: () => 71, reportApprovalBlocked: true });
    await on.onPermissionCheck({ conversationId: "conv-7", phase: "approval" });
    expect(onClient.reports[0]).toMatchObject({
      state: "blocked",
      customStatus: "approval",
      message: "Approval required",
    });
  });

  test("clear authority clears display metadata and this source's lifecycle authority", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 80 });

    await reporter.clearAuthority();

    expect(client.metadata[0]).toMatchObject({
      clearSummary: true,
      clearStateLabels: true,
      clearDisplayAgent: true,
      seq: 80_001,
    });
    expect(client.clears[0]).toEqual({ seq: 80_001 });
  });
});
