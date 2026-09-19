import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HerdrClient } from "../src/herdr-client";
import { MetadataReporter } from "../src/metadata-reporter";

const bin = process.env.HERDR_TEST_BIN ?? "/tmp/herdr-v0.9.1-research";
const source = process.env.HERDR_TEST_SOURCE ?? "/root/workspace/herdr";
const hook = join(
  source,
  "src/integration/assets/letta/herdr-agent-session.sh",
);
const available = existsSync(bin) && existsSync(hook);
if (!available)
  console.warn(
    "SKIP Herdr integration: pinned 0.9.1 binary/native hook unavailable (HERDR_TEST_BIN, HERDR_TEST_SOURCE)",
  );
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 8000,
) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await wait(100);
  } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}
// Test-only raw RPC: native/foreign actors are intentionally not part of the production client.
function rpc(
  path: string,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Error("fixture RPC timeout"));
    }, 2000);
    socket.on("error", reject);
    socket.on("close", () => clearTimeout(timer));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        socket.destroy();
        resolve(JSON.parse(data.split("\n")[0]!));
      }
    });
    socket.connect(path, () =>
      socket.write(JSON.stringify({ id: randomUUID(), method, params }) + "\n"),
    );
  });
}
const walk = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(path, entry.name))
      : [join(path, entry.name)],
  );

test.skipIf(!available)(
  "real Herdr: native coexistence, scoped metadata, TTL, reload and cold native restore",
  async () => {
    expect(createHash("sha256").update(readFileSync(bin)).digest("hex")).toBe(
      "2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7",
    );
    const root = mkdtempSync(join(tmpdir(), "herdr-metadata-"));
    // Deliberately allowlist environment: no user config, credentials, providers or sessions.
    const env: Record<string, string> = {
      PATH: `${root}:${process.env.PATH}`,
      HOME: root,
      TERM: "xterm-256color",
      SHELL: "/bin/bash",
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "run"),
      HERDR_CONFIG_PATH: join(root, "config/herdr/config.toml"),
    };
    for (const name of ["config/herdr", "data", "state", "run"])
      mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      env.HERDR_CONFIG_PATH!,
      "[update]\nmanifest_check = false\n[session]\nresume_agents_on_restore = true\n",
    );
    writeFileSync(
      join(root, "fixture.c"),
      `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char**argv){char p[4096],b[100];snprintf(p,sizeof(p),"%s/launches.txt",getenv("HOME"));FILE*f=fopen(p,"a");fprintf(f,"pane=%s",getenv("HERDR_PANE_ID"));for(int i=0;i<argc;i++)fprintf(f," | %s",argv[i]);fprintf(f,"\\n");fclose(f);printf("\\033[2J\\033[H\\033]0;Fixture\\007› \\n");fflush(stdout);while(fgets(b,sizeof(b),stdin)){if(strncmp(b,"blocked",7)==0)printf("\\033]0;[ ! ] Action Required | Fixture\\007");else if(strncmp(b,"working",7)==0)printf("\\033]0;⠋ Fixture\\007");else printf("\\033]0;Fixture\\007\\033[2J\\033[H› \\n");fflush(stdout);}return 0;}`,
    );
    const cc = spawnSync(
      "gcc",
      [join(root, "fixture.c"), "-o", join(root, "letta")],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(cc.status).toBe(0);
    const session = "metadata-test";
    const cli = (...args: string[]) => {
      const result = spawnSync(bin, ["--session", session, ...args], {
        env,
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
      });
      try {
        return JSON.parse(result.stdout || result.stderr);
      } catch {
        return { status: result.status, text: result.stdout + result.stderr };
      }
    };
    let server: ChildProcess | undefined;
    const start = async () => {
      server = spawn(bin, ["--session", session, "server"], {
        env,
        cwd: root,
        stdio: "ignore",
      });
      await eventually(
        () => cli("status").text?.includes("status: running"),
        "isolated server ready",
      );
    };
    const stop = async () => {
      cli("server", "stop");
      await eventually(
        () => server?.exitCode !== null,
        "isolated server stopped",
      ).catch(() => server?.kill("SIGTERM"));
    };
    const reporters: MetadataReporter[] = [];
    try {
      await start();
      const workspace = cli(
        "workspace",
        "create",
        "--label",
        "metadata-test",
        "--cwd",
        root,
      ).result;
      const panes = [
        workspace.root_pane.pane_id,
        ...[1, 2].map(
          () =>
            cli(
              "tab",
              "create",
              "--workspace",
              workspace.workspace.workspace_id,
            ).result.root_pane.pane_id,
        ),
      ];
      const socketPath = walk(root).find((path) =>
        path.endsWith("/herdr.sock"),
      )!;
      const native = (
        pane: string,
        conversation_id: string,
        agent_id: string,
      ) => {
        const result = spawnSync("/bin/sh", [hook, "session"], {
          env: {
            ...env,
            HERDR_ENV: "1",
            HERDR_SOCKET_PATH: socketPath,
            HERDR_PANE_ID: pane,
            HERDR_BIN_PATH: bin,
          },
          input: JSON.stringify({
            conversation_id,
            agent_id,
            is_new_session: false,
          }),
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status).toBe(0);
      };
      const read = (pane: string) => cli("pane", "get", pane).result.pane;
      const client = (pane: string) =>
        new HerdrClient({ env: { enabled: true, paneId: pane, socketPath } });
      // Well-formed acknowledgement with ignored canonical guard is not verified display.
      const ignored = await client(panes[0]).reportMetadata({
        kind: "name",
        displayAgent: "Ignored",
        seq: 1,
      });
      expect(ignored.ok).toBe(true);
      expect(read(panes[0]).display_agent).not.toBe("Ignored");
      const invalid = new HerdrClient({
        env: { enabled: true, paneId: "w999:p999", socketPath },
      });
      expect((await invalid.getPane()).ok).toBe(false);
      for (const pane of panes) cli("pane", "run", pane, join(root, "letta"));
      await eventually(
        () => panes.every((pane) => read(pane).agent === "letta"),
        "fixture process detected",
      );
      for (const [i, pane] of panes.entries()) {
        const conversation = i === 0 ? "conv-named" : "default";
        const agentId = `agent-${i}`;
        const scope = {
          agentId,
          agentName: `Name ${i}`,
          conversationId: conversation,
        };
        const expectedSession = i === 0 ? conversation : `default:${agentId}`;
        if (i === 0) native(pane, conversation, agentId); // native first
        const r = new MetadataReporter(client(pane), {
          activity: true,
          ttlMs: 250,
        });
        reporters.push(r);
        await r.observe("conversation_open", scope);
        if (i !== 0) native(pane, conversation, agentId); // mod first
        expect(read(pane).agent_session.value).toBe(expectedSession);
        expect(read(pane).display_agent).toBe(`Name ${i}`);
        const nativeIdentity = read(pane).agent_session;
        await rpc(socketPath, "pane.report_metadata", {
          pane_id: pane,
          source: "foreign",
          title: "Foreign title",
          tokens: { foreign: "preserved" },
          seq: 1,
        });
        for (const state of ["working", "blocked", "idle"]) {
          cli("pane", "send-text", pane, state);
          cli("pane", "send-keys", pane, "enter");
          await eventually(() => {
            const actual = read(pane).agent_status;
            return actual === state || (state === "idle" && actual === "done");
          }, `native ${state} (or native completion badge)`);
          expect(read(pane).agent_session).toEqual(nativeIdentity);
        }
        cli("pane", "send-text", pane, "working");
        cli("pane", "send-keys", pane, "enter");
        await eventually(
          () => read(pane).agent_status === "working",
          "long native work",
        );
        await r.observe("turn_start", scope);
        expect(read(pane).state_labels.working).toBe("processing");
        await wait(500);
        expect(read(pane).state_labels?.working).toBeUndefined();
        expect(read(pane).agent_status).toBe("working");
        expect(read(pane).display_agent).toBe(`Name ${i}`);
        await r.observe("conversation_open", {
          agentId: "other",
          conversationId: "default",
        });
        expect(read(pane).display_agent).toBeUndefined();
        await r.observe("conversation_open", {
          agentId: "other",
          conversationId: "default",
          agentName: "Renamed",
        });
        expect(read(pane).display_agent).toBe("Renamed");
        const next = new MetadataReporter(client(pane), {
          displayAgent: "Override",
        });
        reporters.push(next);
        await next.observe("turn_start", scope);
        await r.dispose();
        expect(read(pane).display_agent).toBe("Override");
        await next.dispose();
        const after = read(pane);
        expect(after.agent_session).toEqual(nativeIdentity);
        expect(after.tokens.foreign).toBe("preserved");
        expect(after.title).toBe("Foreign title");
        expect(after.display_agent).toBeUndefined();
      }
      // A real cold restart must still dispatch native named and agent-qualified default commands.
      await stop();
      await start();
      await eventually(
        () =>
          readFileSync(join(root, "launches.txt"), "utf8")
            .split("\n")
            .filter(Boolean).length >= 6,
        "cold native restore",
        12000,
      );
      const launches = readFileSync(join(root, "launches.txt"), "utf8");
      expect(launches).toContain(" | --conversation | conv-named");
      expect(launches).toContain(" | --agent | agent-1");
      expect(launches).toContain(" | --agent | agent-2");
      expect(launches.match(/ \| --conversation \| default/g)).toHaveLength(2);
    } finally {
      await Promise.all(reporters.map((reporter) => reporter.dispose()));
      if (server?.exitCode === null) await stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  90000,
);
