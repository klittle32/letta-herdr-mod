import { afterEach, beforeEach, expect, test } from "bun:test";
import activate, {
  createReporterFromEnv,
  formatStatus,
  parseActivityTtl,
} from "../src/index";
let savedHerdrEnv: string | undefined;
beforeEach(() => {
  savedHerdrEnv = process.env.HERDR_ENV;
  // Capability registration tests deliberately perform no IPC. Enabled runtime
  // behavior is covered by the actual App fixture and isolated Herdr gate.
  delete process.env.HERDR_ENV;
});
afterEach(() => {
  if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedHerdrEnv;
});
function fake(
  capabilities: any = {
    events: { lifecycle: true, turns: true, tools: true, llm: true },
    commands: true,
  },
) {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const api = {
    capabilities,
    events: {
      on: (name: string, fn: any) => {
        handlers.set(name, fn);
        return () => {
          handlers.delete(name);
        };
      },
    },
    commands: {
      register: (c: any) => {
        commands.set(c.id, c);
        return () => {
          commands.delete(c.id);
        };
      },
    },
    permissions: {
      register() {
        throw Error("permission overlay forbidden");
      },
    },
  };
  return { api, handlers, commands };
}
test("supported events only, no permission overlay or repair; optional Cloud capabilities", () => {
  const f = fake();
  const dispose = activate(f.api);
  expect([...f.commands.keys()]).toEqual(["herdr-status"]);
  expect(f.handlers.size).toBe(8);
  expect(
    f.handlers.get("tool_start")(
      { toolName: "Read", toolCallId: "1", args: {} },
      { agent: { id: "a", name: "Alice" } },
    ),
  ).toBeUndefined();
  expect(
    f.handlers.get("llm_end")(
      {
        agentId: "a",
        conversationId: "default",
        model: "fake",
        stopReason: "error",
        usage: null,
        durationMs: 1,
        error: {
          message: "private",
          detail: "private",
          errorType: "llm_error",
          retryable: false,
        },
      },
      {},
    ),
  ).toBeUndefined();
  dispose();
  expect(f.handlers.size).toBe(0);
  expect(f.commands.size).toBe(0);
  const cloud = fake({ events: { tools: true, turns: true }, commands: true });
  const close = activate(cloud.api);
  expect([...cloud.handlers.keys()]).toEqual([
    "turn_start",
    "turn_end",
    "tool_start",
    "tool_end",
  ]);
  close();
  activate({})();
});
test("outside Herdr and inherited subagent environments do no IPC", async () => {
  expect(createReporterFromEnv({}).reporter).toBeUndefined();
  const child = createReporterFromEnv({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/unused",
    HERDR_PANE_ID: "w1:p1",
    LETTA_CODE_AGENT_ROLE: "subagent",
  });
  expect(child.reporter).toBeUndefined();
  expect(await formatStatus(child, {})).toContain("subagent");
});
test("bounded positive TTL and retired settings warnings", () => {
  for (const value of [undefined, "0", "-1", "86400001", "NaN", "3.5"])
    expect(parseActivityTtl(value)).toBe(30000);
  expect(parseActivityTtl("86400000")).toBe(86400000);
  expect(
    createReporterFromEnv({
      LETTA_HERDR_AGENT: "old",
      LETTA_HERDR_IDLE_DELAY_MS: "1",
    }).warnings.join(" "),
  ).toContain("retired");
});
test("status reads only; acknowledgement, desired name and readback never conflate", async () => {
  let reads = 0;
  const bundle: any = {
    env: { enabled: true, paneId: "w1:p1", socketPath: "/fake" },
    warnings: [],
    reporter: {
      snapshot: () => ({
        expectedName: "Expected",
        lastAck: true,
        activity: false,
        ttlMs: 30000,
      }),
    },
    client: {
      getPane: async () => {
        reads++;
        return {
          ok: true,
          response: {
            pane: {
              pane_id: "w1:p1",
              display_agent: "Other",
              agent_status: "working",
              agent_session: {
                source: "herdr:letta",
                agent: "letta",
                kind: "id",
                value: "default:other",
              },
            },
          },
        };
      },
    },
  };
  const text = await formatStatus(bundle, {
    agent: { id: "a", name: "Expected" },
    conversation: { id: "default" },
  });
  expect(reads).toBe(1);
  expect(text).toContain("Expected");
  expect(text).toContain("Other");
  expect(text).toContain("mismatch");
  expect(text).toContain("not proof");
  bundle.client.getPane = async () => ({
    ok: true,
    response: {
      pane: {
        pane_id: "w1:p1",
        agent_status: "idle",
        agent_session: {
          source: "old-custom",
          agent: "letta-code",
          value: "default:a",
        },
      },
    },
  });
  expect(
    await formatStatus(bundle, {
      agent: { id: "a" },
      conversation: { id: "default" },
    }),
  ).toContain("not native Letta");
  bundle.client.getPane = async () => ({
    ok: true,
    response: {
      pane: {
        pane_id: "w1:p1",
        agent_status: "idle",
        agent_session: {
          source: "herdr:letta",
          agent: "letta",
          kind: "path",
          value: "default:a",
        },
      },
    },
  });
  expect(
    await formatStatus(bundle, {
      agent: { id: "a" },
      conversation: { id: "default" },
    }),
  ).toContain("not native Letta");
  bundle.client.getPane = async () => ({ ok: true, response: {} });
  expect(await formatStatus(bundle, {})).toContain("invalid pane read-back");
});
