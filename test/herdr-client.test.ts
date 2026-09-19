import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  HerdrClient,
  deriveMetadataSources,
  normalizeLabel,
  resolveHerdrEnv,
} from "../src/herdr-client";

async function fixture(
  run: (client: HerdrClient, requests: any[]) => Promise<void>,
  reply: (r: any) => string | null | undefined = (r) =>
    JSON.stringify({ id: r.id, result: { type: "ok" } }) + "\n",
) {
  const root = mkdtempSync(join(tmpdir(), "herdr-client-"));
  const socketPath = join(root, "api.sock");
  const requests: any[] = [];
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const response = reply(request);
      if (response === null) socket.end();
      else if (response !== undefined) socket.end(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await run(
      new HerdrClient({
        env: { enabled: true, socketPath, paneId: "w1:p1" },
        requestTimeoutMs: 50,
      }),
      requests,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test("presentation-only surface, canonical guard, explicit isolated clears and read-only lookup", async () => {
  await fixture(async (client, requests) => {
    expect("reportAgent" in client).toBe(false);
    expect("releaseAgent" in client).toBe(false);
    expect("clearAgentAuthority" in client).toBe(false);
    expect("sendRequest" in client).toBe(false);
    expect(
      (
        await client.reportMetadata({
          kind: "name",
          displayAgent: "HAL",
          seq: 1,
        })
      ).ok,
    ).toBe(true);
    await client.reportMetadata({ kind: "name", clear: true, seq: 2 });
    await client.reportMetadata({
      kind: "activity",
      working: "thinking",
      ttlMs: 30000,
      seq: 3,
    });
    await client.reportMetadata({ kind: "activity", clear: true, seq: 4 });
    await client.getPane();
    expect(requests.map((r) => r.method)).toEqual([
      "pane.report_metadata",
      "pane.report_metadata",
      "pane.report_metadata",
      "pane.report_metadata",
      "pane.get",
    ]);
    expect(requests[0].params).toEqual({
      pane_id: "w1:p1",
      source: client.sources.name,
      agent: "letta",
      seq: 1,
      display_agent: "HAL",
    });
    expect(requests[1].params).toEqual({
      pane_id: "w1:p1",
      source: client.sources.name,
      agent: "letta",
      seq: 2,
      clear_display_agent: true,
    });
    expect(requests[2].params.state_labels).toEqual({ working: "thinking" });
    expect(requests[2].params.ttl_ms).toBe(30000);
    expect(requests[3].params).toEqual({
      pane_id: "w1:p1",
      source: client.sources.activity,
      agent: "letta",
      seq: 4,
      clear_state_labels: true,
    });
    expect(requests[4].params).toEqual({ pane_id: "w1:p1" });
  });
});

for (const [label, reply] of Object.entries({
  timeout: () => undefined,
  error: (r: any) =>
    JSON.stringify({
      id: r.id,
      error: { code: "not_found", message: "secret body" },
    }) + "\n",
  malformed: () => "not json\n",
  unexpected: (r: any) => JSON.stringify({ id: r.id, wat: true }) + "\n",
  wrongId: () => '{"id":"wrong","result":{}}\n',
  disconnect: () => null,
  oversized: () => "x".repeat(65537),
  both: (r: any) => JSON.stringify({ id: r.id, result: {}, error: {} }) + "\n",
}))
  test(`rejects ${label}`, async () =>
    fixture(async (client) => {
      const result = await client.getPane();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret body");
    }, reply));

test("a correlated but wrong result type is not a metadata acknowledgement", async () =>
  fixture(
    async (client) => {
      expect(
        (
          await client.reportMetadata({
            kind: "name",
            displayAgent: "Name",
            seq: 1,
          })
        ).ok,
      ).toBe(false);
    },
    (r) => JSON.stringify({ id: r.id, result: { type: "pong" } }) + "\n",
  ));

test("invalid combinations and TTL fail before IPC", async () =>
  fixture(async (client, requests) => {
    for (const input of [
      { kind: "name", displayAgent: "x", clear: true, seq: 1 },
      { kind: "activity", working: "x", clear: true, seq: 1 },
      ...[0, -1, 86400001, undefined].map((ttlMs) => ({
        kind: "activity",
        working: "x",
        ttlMs,
        seq: 1,
      })),
    ])
      expect((await client.reportMetadata(input as any)).ok).toBe(false);
    expect(requests).toHaveLength(0);
  }));

test("sources are stable, bounded, distinct and collision resistant; Unicode uses scalar limits", () => {
  const a = deriveMetadataSources("a".repeat(80));
  const b = deriveMetadataSources("a".repeat(79) + "b");
  expect(a).toEqual(deriveMetadataSources("a".repeat(80)));
  expect(a.name).not.toBe(a.activity);
  expect(a.name).not.toBe(b.name);
  expect(a.name.length).toBeLessThanOrEqual(80);
  expect(normalizeLabel("\u0085\u0000 " + "😀".repeat(90))).toBe(
    "😀".repeat(80),
  );
  expect(resolveHerdrEnv({}).enabled).toBe(false);
});
