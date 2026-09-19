// Execute the actual v0.9.1 Unix hook against a recording CLI, not a live session.
// bun docs/research/native-integration/native-hook-probes.ts /path/to/herdr
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const source = process.argv[2];
if (!source) throw new Error("Supply pinned Herdr source directory");
const hook = resolve(source, "src/integration/assets/letta/herdr-agent-session.sh");
const dir = mkdtempSync(join(tmpdir(), "letta-native-hook-probe-"));
const capture = join(dir, "args.json");
const fake = join(dir, "herdr");
writeFileSync(fake, `#!/usr/bin/env bun\nawait Bun.write(process.env.PROBE_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
const cases = [
  { label: "named-new", input: { conversation_id: "conv-fixture", agent_id: "agent-a", is_new_session: true }, expected: "conv-fixture", start: "new" },
  { label: "named-resume", input: { conversation_id: "conv-fixture", agent_id: "agent-a", is_new_session: false }, expected: "conv-fixture", start: "resume" },
  { label: "default-a", input: { conversation_id: "default", agent_id: "agent-a" }, expected: "default:agent-a", start: "resume" },
  { label: "default-b", input: { conversation_id: "default", agent_id: "agent-b" }, expected: "default:agent-b", start: "resume" },
  { label: "invalid-default", input: { conversation_id: "default" }, expected: undefined },
  { label: "invalid-empty", input: { conversation_id: "" }, expected: undefined },
];
try {
  for (const c of cases) {
    rmSync(capture, { force: true });
    const result = spawnSync("sh", [hook, "session"], {
      input: JSON.stringify(c.input), encoding: "utf8",
      env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w-test:p1", HERDR_SOCKET_PATH: join(dir, "unused.sock"), HERDR_BIN_PATH: fake, PROBE_CAPTURE: capture },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    if (!c.expected) { assert.equal(existsSync(capture), false); }
    else {
      const args = JSON.parse(readFileSync(capture, "utf8"));
      const value = (flag: string) => args[args.indexOf(flag) + 1];
      assert.equal(value("--agent-session-id"), c.expected);
      assert.equal(value("--session-start-source"), c.start);
      assert.equal(value("--source"), "herdr:letta");
      assert.equal(value("--agent"), "letta");
      assert.deepEqual(args.slice(0, 2), ["pane", "report-agent-session"]);
    }
    console.log(`${c.label}: PASS (silent; ${c.expected ?? "no report"})`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
