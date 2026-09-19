import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MetadataReporter } from "../src/metadata-reporter";
import type { MetadataInput, HerdrResult } from "../src/herdr-client";
function fixture(options = {}, laneKey = randomUUID()) {
  const writes: MetadataInput[] = [];
  const client = {
    laneKey,
    reportMetadata: async (input: MetadataInput): Promise<HerdrResult> => {
      writes.push(input);
      return { ok: true, response: {} };
    },
  };
  return { writes, client, reporter: new MetadataReporter(client, options) };
}
const ctx = (
  id = "a",
  name: string | undefined = "Alice",
  conversationId = "default",
) => ({ agent: { id, name }, conversation: { id: conversationId } });

for (const inflight of [false, true]) {
  test(`latest name wins Alice/Bob/Alice with ${inflight ? "inflight" : "queued"} writes`, async () => {
    const f = fixture();
    await f.reporter.observe("turn_start", {}, ctx());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.client.reportMetadata = async (input) => {
      f.writes.push(input);
      if ("displayAgent" in input && input.displayAgent === "Bob") await gate;
      return { ok: true, response: {} };
    };
    void f.reporter.observe("tool_start", {}, ctx("a", "Bob"));
    if (inflight) await new Promise((resolve) => setTimeout(resolve, 0));
    void f.reporter.observe("tool_start", {}, ctx());
    release();
    await f.reporter.flush();
    expect(f.writes.filter((w) => "displayAgent" in w).at(-1)).toMatchObject({
      displayAgent: "Alice",
    });
    expect(f.reporter.snapshot().expectedName).toBe("Alice");
    await f.reporter.dispose();
  });
}

test("name override, scoped renames, missing names and two agents' default contexts", async () => {
  const { reporter: r, writes } = fixture();
  await r.observe(
    "conversation_open",
    { agentId: "a", agentName: "Alice", conversationId: "default" },
    ctx(),
  );
  await r.observe("turn_start", {}, ctx());
  expect(writes.filter((w) => "displayAgent" in w)).toHaveLength(1);
  await r.observe("tool_start", {}, ctx("a", "Renamed"));
  expect(writes.at(-1)).toMatchObject({
    kind: "name",
    displayAgent: "Renamed",
  });
  await r.observe(
    "conversation_open",
    { agentId: "b", conversationId: "default" },
    ctx(),
  );
  expect(r.snapshot().expectedName).toBeUndefined();
  expect(writes.at(-1)).toMatchObject({ kind: "name", clear: true });
  await r.dispose();
  const o = fixture({ displayAgent: "Override" });
  await o.reporter.observe("conversation_open", { agentId: "b" }, ctx());
  expect(o.writes.at(-1)).toMatchObject({ displayAgent: "Override" });
  await o.reporter.dispose();
});
test("same scoped missing name preserves intent but mismatched context never supplies a name", async () => {
  const { reporter: r } = fixture();
  await r.observe("turn_start", {}, ctx());
  await r.observe(
    "tool_start",
    { agentId: "a", conversationId: "default" },
    {},
  );
  expect(r.snapshot().expectedName).toBe("Alice");
  await r.observe(
    "turn_start",
    { agentId: "b", conversationId: "default" },
    ctx(),
  );
  expect(r.snapshot().expectedName).toBeUndefined();
  await r.dispose();
});
test("parallel tools, missing IDs, TTL refresh, no stale activity from name-only events", async () => {
  const { reporter: r, writes } = fixture({ activity: true, ttlMs: 100 });
  await r.observe("turn_start", {}, ctx());
  await r.observe("tool_start", { toolCallId: "1", toolName: "Read" }, ctx());
  await r.observe("tool_start", { toolCallId: "2", toolName: "Bash" }, ctx());
  expect(writes.at(-1)).toMatchObject({ working: "tools:2", ttlMs: 100 });
  await r.observe("tool_end", { toolCallId: "1", status: "error" }, ctx());
  expect(writes.at(-1)).toMatchObject({ working: "tool:Bash" });
  await r.observe("tool_end", {}, ctx());
  expect(writes.at(-1)).toMatchObject({ working: "tool:Bash" });
  const count = writes.length;
  await r.observe(
    "conversation_open",
    { agentId: "a", agentName: "Rename", conversationId: "default" },
    ctx(),
  );
  expect(writes.slice(count).every((w) => w.kind === "name")).toBe(true);
  await r.observe(
    "llm_end",
    {
      error: {
        message: "private",
        detail: "private",
        errorType: "llm_error",
        retryable: false,
      },
    },
    ctx(),
  );
  expect(writes.at(-1)).toMatchObject({ kind: "activity", clear: true });
  expect(JSON.stringify(writes)).not.toContain("private");
  await r.dispose();
});
test("failed name acknowledgement is retried; disposal ignores late events", async () => {
  const f = fixture();
  let fail = true;
  f.client.reportMetadata = async (input) => {
    f.writes.push(input);
    return fail ? { ok: false, error: "failure" } : { ok: true, response: {} };
  };
  await f.reporter.observe("turn_start", {}, ctx());
  fail = false;
  await f.reporter.observe("turn_start", {}, ctx());
  expect(f.writes.filter((w) => "displayAgent" in w)).toHaveLength(2);
  await f.reporter.dispose();
  const count = f.writes.length;
  await f.reporter.observe("turn_start", {}, ctx());
  expect(f.writes).toHaveLength(count);
});
test("inflight context switch drops queued old payloads, closes after admitted writes", async () => {
  const f = fixture();
  await f.reporter.flush();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.client.reportMetadata = async (input) => {
    f.writes.push(input);
    if ("displayAgent" in input && input.displayAgent === "Alice") await gate;
    return { ok: true, response: {} };
  };
  void f.reporter.observe("turn_start", {}, ctx());
  await new Promise((r) => setTimeout(r, 0));
  void f.reporter.observe("tool_start", {}, ctx("a", "OLD QUEUED"));
  void f.reporter.observe(
    "conversation_open",
    { agentId: "b", agentName: "Bob", conversationId: "default" },
    ctx(),
  );
  release();
  await f.reporter.flush();
  expect(
    f.writes.some(
      (w) => "displayAgent" in w && w.displayAgent === "OLD QUEUED",
    ),
  ).toBe(false);
  expect(f.writes.at(-1)).toMatchObject({ displayAgent: "Bob" });
  await f.reporter.dispose();
});
test("inflight reload orders replacement clears after old socket write and fences late callbacks", async () => {
  const f = fixture({ activity: true });
  await f.reporter.flush();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.client.reportMetadata = async (input) => {
    f.writes.push(input);
    if ("displayAgent" in input && input.displayAgent === "Alice") await gate;
    return { ok: true, response: {} };
  };
  void f.reporter.observe("turn_start", {}, ctx());
  await new Promise((resolve) => setTimeout(resolve, 0));
  void f.reporter.observe(
    "tool_start",
    { toolCallId: "old", toolName: "OLD" },
    ctx(),
  );
  const next = new MetadataReporter(f.client);
  void next.observe("conversation_open", {
    agentId: "b",
    agentName: "Bob",
    conversationId: "default",
  });
  void f.reporter.dispose();
  release();
  await next.flush();
  expect(f.writes.at(-1)).toMatchObject({ kind: "name", displayAgent: "Bob" });
  expect(f.writes.some((w) => "working" in w)).toBe(false);
  const count = f.writes.length;
  await next.observe(
    "tool_end",
    { agentId: "a", conversationId: "default", toolCallId: "old" },
    ctx(),
  );
  expect(f.writes).toHaveLength(count);
  await next.observe("conversation_close", {
    agentId: "b",
    conversationId: "default",
  });
  expect(f.writes.at(-1)).toMatchObject({ kind: "name", clear: true });
  const closedCount = f.writes.length;
  await next.observe("llm_start", { agentId: "b", conversationId: "default" });
  expect(f.writes).toHaveLength(closedCount);
  await next.dispose();
});

test("cache-busted reload shares transport lane; late old disposer cannot clear replacement", async () => {
  const f = fixture({ activity: true });
  await f.reporter.observe("turn_start", {}, ctx());
  const { MetadataReporter: Reloaded } = await import(
    `../src/metadata-reporter.ts?reload=${randomUUID()}`
  );
  const next = new Reloaded(f.client, {});
  await next.observe("turn_start", {}, ctx("b", "Bob"));
  const count = f.writes.length;
  await f.reporter.dispose();
  expect(f.writes).toHaveLength(count);
  expect(f.writes.at(-1)).toMatchObject({ displayAgent: "Bob" });
  expect(f.writes.some((w) => w.kind === "activity" && w.clear)).toBe(true);
  expect(f.writes.map((w) => w.seq)).toEqual(
    [...f.writes.map((w) => w.seq)].sort((a, b) => a - b),
  );
  await next.dispose();
});
