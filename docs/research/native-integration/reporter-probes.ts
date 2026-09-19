// Provider-free probes of the shipped reporter, not proposed production changes.
// Run from repository root: bun docs/research/native-integration/reporter-probes.ts
import { strict as assert } from "node:assert";
import { HerdrStateReporter } from "../../../src/state-reporter";
import { HerdrClient } from "../../../src/herdr-client";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class Recorder {
  reports: any[] = [];
  metadata: any[] = [];
  async reportAgent(input: any) { this.reports.push(input); return { ok: true as const }; }
  async reportMetadata(input: any) { this.metadata.push(input); return { ok: true as const }; }
  async releaseAgent() { return { ok: true as const }; }
  async clearAgentAuthority() { return { ok: true as const }; }
}
const results: Record<string, unknown> = {};

{
  const c = new Recorder();
  const r = new HerdrStateReporter(c, { staleWorkingMs: 20 });
  await r.onTurnStart({ conversationId: "conv-fixture" });
  await r.onToolStart({ conversationId: "conv-fixture", toolName: "fixture" });
  await r.onToolEnd({ conversationId: "conv-fixture" });
  await sleep(60);
  assert.equal(c.reports.at(-1).state, "working");
  results.noRecoveryAfterTool = "tool_start cancels stale timer; tool_end does not rearm it; missing turn_end leaves working";
  await r.release();
}
{
  const c = new Recorder();
  const r = new HerdrStateReporter(c);
  await r.onLlmEnd({ error: { message: "fixture provider failure", detail: "fixture", errorType: "llm_error", retryable: false } });
  assert.equal(c.reports[0].message, "LLM error: [object Object]");
  results.structuredLlmError = c.reports[0].message;
  await r.release();
}
{
  const c = new Recorder();
  const r = new HerdrStateReporter(c, { staleWorkingMs: 20 });
  await r.onLlmStart({ conversationId: "conv-fixture" });
  await sleep(60);
  assert.equal(c.reports.at(-1).state, "idle");
  results.staleFallback = { observed: "working -> idle with no completion", configuredMs: 20,
    note: "Scaled timer; shipped default is 300000 ms, not a five-minute wall-clock test." };
  await r.release();
}
{
  const c = new Recorder();
  const r = new HerdrStateReporter(c, { idleDelayMs: 10 });
  await r.onLlmEnd({ conversationId: "conv-fixture", error: new Error("fixture failure") });
  r.onTurnEnd({ conversationId: "conv-fixture" });
  await sleep(40);
  assert.deepEqual(c.reports.map(x => x.state), ["blocked", "idle"]);
  results.errorThenTurnEnd = "blocked overwritten by idle after turn_end";
  await r.release();
}
{
  const c = new Recorder();
  const r = new HerdrStateReporter(c);
  r.setDisplayAgent("First");
  await r.report("idle", "ready", "conv-fixture");
  r.setDisplayAgent("Second");
  await r.report("idle", "ready", "conv-fixture");
  assert.equal(c.metadata.length, 1);
  assert.equal(c.metadata[0].displayAgent, "First");
  results.renameDedup = "Name-only change not emitted for identical state/status/conversation";
  r.setDisplayAgent(undefined);
  await r.report("working", "thinking", "conv-other");
  assert.equal(c.metadata.at(-1).displayAgent, "Second");
  results.missingName = "Previous agent name retained when next context supplies no name";
  await r.release();
}
{
  const c = new Recorder();
  const r = new HerdrStateReporter(c);
  await r.report("blocked", "llm error", "conv-fixture", "first failure");
  await r.report("blocked", "llm error", "conv-fixture", "second failure");
  assert.equal(c.reports.length, 1);
  results.errorMessageDedup = "Changed error message dropped for identical state/status/conversation";
  await r.release();
}
{
  const c = new Recorder();
  c.reportMetadata = async () => ({ ok: false, error: "fixture metadata rejection" } as any);
  const r = new HerdrStateReporter(c);
  const outcome = await r.clearAuthority();
  assert.equal(outcome.ok, true);
  assert.equal(r.snapshot().lastResultOk, false);
  results.repairPartialFailure = "Return value says success although metadata cleanup failed";
}
{
  const client = new HerdrClient({ displayAgent: "Configured override" });
  const requests: any[] = [];
  client.sendRequest = async (method, params) => { requests.push({method, params}); return {ok:true}; };
  await client.reportMetadata({ seq: 1, displayAgent: "Context name" });
  assert.equal(requests[0].params.display_agent, "Context name");
  await client.reportMetadata({ seq: 2, clearDisplayAgent: true });
  assert.equal(requests[1].params.display_agent, "Configured override");
  assert.equal(requests[1].params.clear_display_agent, true);
  results.overridePrecedence = "Context name overrides configured display override";
  results.cleanupWire = "Sends both display_agent and clear_display_agent; server precedence must be checked";
}
console.log(JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
