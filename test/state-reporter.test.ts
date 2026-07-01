import { describe, expect, test } from "bun:test";
import { HerdrStateReporter } from "../src/state-reporter";
import type { HerdrAgentState, HerdrResult, ReleaseAgentInput, ReportAgentInput } from "../src/herdr-client";

class FakeClient {
  reports: ReportAgentInput[] = [];
  releases: ReleaseAgentInput[] = [];

  async reportAgent(input: ReportAgentInput): Promise<HerdrResult> {
    this.reports.push({ ...input });
    return { ok: true };
  }

  async releaseAgent(input: ReleaseAgentInput): Promise<HerdrResult> {
    this.releases.push({ ...input });
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

  test("llm errors report blocked", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 40, idleDelayMs: 10 });

    await reporter.onLlmEnd({ conversationId: "conv-4", stopReason: "error", error: new Error("boom") });

    expect(client.reports).toHaveLength(1);
    expect(client.reports[0]).toMatchObject({ state: "blocked", customStatus: "llm error" });
  });

  test("deduplicates identical reports but increments seq for changes", async () => {
    let now = 50;
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => now, idleDelayMs: 10 });

    await reporter.report("working", "thinking", "conv-5");
    await reporter.report("working", "thinking", "conv-5");
    now = 51;
    await reporter.report("working", "tool:Read", "conv-5");

    expect(client.reports).toHaveLength(2);
    expect(client.reports.map((r) => r.seq)).toEqual([50_001, 51_002]);
  });

  test("release clears timers and releases authority", async () => {
    const client = new FakeClient();
    const reporter = new HerdrStateReporter(client, { now: () => 60, idleDelayMs: 50 });

    reporter.onLlmEnd({ conversationId: "conv-6", stopReason: "stop" });
    await reporter.release("conv-6");
    await sleep(70);

    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toMatchObject({ seq: 60_001, agentSessionId: "conv-6" });
    expect(client.reports).toHaveLength(0);
  });

  test("approval blocked reporting is opt-in", async () => {
    const offClient = new FakeClient();
    const off = new HerdrStateReporter(offClient, { now: () => 70, reportApprovalBlocked: false });
    await off.onPermissionCheck({ conversationId: "conv-7", phase: "approval" });
    expect(offClient.reports).toHaveLength(0);

    const onClient = new FakeClient();
    const on = new HerdrStateReporter(onClient, { now: () => 71, reportApprovalBlocked: true });
    await on.onPermissionCheck({ conversationId: "conv-7", phase: "approval" });
    expect(onClient.reports[0]).toMatchObject({ state: "blocked", customStatus: "approval" });
  });
});
