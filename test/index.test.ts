import { describe, expect, test } from "bun:test";
import activate, {
  createReporterFromEnv,
  extractDisplayAgent,
  parseIdleDelayMs,
  parsePostToolIdleMs,
  parseStaleWorkingMs,
  parseToolWatchdogMs,
  shouldReportApprovalBlocked,
} from "../src/index";

type Handler = (...args: any[]) => unknown;

function createFakeLetta() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  const permissions: any[] = [];
  const disposers: (() => void)[] = [];

  const letta = {
    capabilities: {
      events: { lifecycle: true, turns: true, tools: true, llm: true },
      commands: true,
      permissions: true,
    },
    events: {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
        const dispose = () => handlers.delete(name);
        disposers.push(dispose);
        return dispose;
      },
    },
    commands: {
      register(command: any) {
        commands.set(command.id, command);
        const dispose = () => commands.delete(command.id);
        disposers.push(dispose);
        return dispose;
      },
    },
    permissions: {
      register(overlay: any) {
        permissions.push(overlay);
        const dispose = () => permissions.splice(permissions.indexOf(overlay), 1);
        disposers.push(dispose);
        return dispose;
      },
    },
  };

  return { letta, handlers, commands, permissions, disposers };
}

describe("mod config helpers", () => {
  test("parses idle delay safely", () => {
    expect(parseIdleDelayMs(undefined)).toBe(250);
    expect(parseIdleDelayMs("25")).toBe(25);
    expect(parseIdleDelayMs("0")).toBe(250);
    expect(parseIdleDelayMs("25ms")).toBe(250);
    expect(parseIdleDelayMs("abc")).toBe(250);
  });

  test("parses stale working fallback safely", () => {
    expect(parseStaleWorkingMs(undefined)).toBe(300_000);
    expect(parseStaleWorkingMs("5000")).toBe(5_000);
    expect(parseStaleWorkingMs("0")).toBe(0);
    expect(parseStaleWorkingMs("-1")).toBe(300_000);
    expect(parseStaleWorkingMs("abc")).toBe(300_000);
  });

  test("parses post-tool idle fallback safely", () => {
    expect(parsePostToolIdleMs(undefined)).toBe(0);
    expect(parsePostToolIdleMs("2500")).toBe(2_500);
    expect(parsePostToolIdleMs("0")).toBe(0);
    expect(parsePostToolIdleMs("2.5")).toBe(0);
    expect(parsePostToolIdleMs("abc")).toBe(0);
  });

  test("parses tool watchdog safely", () => {
    expect(parseToolWatchdogMs(undefined)).toBe(0);
    expect(parseToolWatchdogMs("30000")).toBe(30_000);
    expect(parseToolWatchdogMs("0")).toBe(0);
    expect(parseToolWatchdogMs("abc")).toBe(0);
  });

  test("parses approval blocked flag", () => {
    expect(shouldReportApprovalBlocked({})).toBe(false);
    expect(shouldReportApprovalBlocked({ LETTA_HERDR_APPROVAL_BLOCKED: "1" })).toBe(true);
    expect(shouldReportApprovalBlocked({ LETTA_HERDR_APPROVAL_BLOCKED: "true" })).toBe(true);
  });

  test("creates reporter only inside Herdr", () => {
    expect(createReporterFromEnv({}).reporter).toBeUndefined();
    const bundle = createReporterFromEnv({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "w1:p1",
      AGENT_NAME: "Johnny5",
    });
    expect(bundle.reporter).toBeDefined();
    expect((bundle.client as any).displayAgent).toBe("Johnny5");
  });

  test("extracts display agent from mod event context", () => {
    expect(extractDisplayAgent({ agent: { name: "Johnny5" } })).toBe("Johnny5");
    expect(extractDisplayAgent({ agent: { name: "  " } })).toBeUndefined();
    expect(extractDisplayAgent({})).toBeUndefined();
  });
});

describe("activate", () => {
  test("registers event handlers, command, permission overlay, and cleanup", () => {
    const fake = createFakeLetta();
    const dispose = activate(fake.letta as any);

    expect(fake.handlers.has("conversation_open")).toBe(true);
    expect(fake.handlers.has("conversation_close")).toBe(true);
    expect(fake.handlers.has("turn_start")).toBe(true);
    expect(fake.handlers.has("turn_end")).toBe(true);
    expect(fake.handlers.has("tool_start")).toBe(true);
    expect(fake.handlers.has("tool_end")).toBe(true);
    expect(fake.handlers.has("llm_start")).toBe(true);
    expect(fake.handlers.has("llm_end")).toBe(true);
    expect(fake.commands.has("herdr-status")).toBe(true);
    expect(fake.commands.has("herdr-repair")).toBe(true);
    expect(fake.permissions).toHaveLength(1);

    dispose?.();
    expect(fake.handlers.size).toBe(0);
    expect(fake.commands.size).toBe(0);
    expect(fake.permissions).toHaveLength(0);
  });

  test("turn handlers require the turns event capability", () => {
    const fake = createFakeLetta();
    fake.letta.capabilities.events.turns = false;

    const dispose = activate(fake.letta as any);

    expect(fake.handlers.has("conversation_open")).toBe(true);
    expect(fake.handlers.has("turn_start")).toBe(false);
    expect(fake.handlers.has("turn_end")).toBe(false);

    dispose?.();
  });

  test("/herdr-status explains disabled state", () => {
    const saved = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    };
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;

    try {
      const fake = createFakeLetta();
      activate(fake.letta as any);

      const result = fake.commands.get("herdr-status").run({ args: "" });
      expect(result.type).toBe("output");
      expect(result.output).toContain("letta-herdr-mod: disabled");
      expect(result.output).toContain("HERDR_ENV is not 1");
    } finally {
      if (saved.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = saved.HERDR_ENV;
      if (saved.HERDR_SOCKET_PATH === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = saved.HERDR_SOCKET_PATH;
      if (saved.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = saved.HERDR_PANE_ID;
    }
  });
});
