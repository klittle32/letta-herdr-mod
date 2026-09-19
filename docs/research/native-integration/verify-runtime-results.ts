// Assert key read-back facts after runtime-probes.ts. No live session writes.
import { strict as assert } from "node:assert";
const file = process.argv[2] ?? "/tmp/herdr-issue4-runtime-results.json";
const records = await Bun.file(file).json();
const byLabel = new Map<string, any>(records.map((r: any) => [r.label, r.value]));
const get = (label: string) => { assert(byLabel.has(label), `Missing ${label}`); return byLabel.get(label); };
const pane = (label: string) => get(label).result.pane;
const checks: string[] = [];
for (const state of ["working", "blocked", "idle"]) {
  assert.equal(pane(`native-screen-${state}`).agent_status, state);
  checks.push(`Native fixture publishes ${state}`);
}
assert.equal(pane("native-then-mod").agent_status, "idle");
assert.equal(pane("native-then-mod").display_agent, undefined);
checks.push("Native-first rejects mod state and hides guarded name");
assert.equal(pane("metadata-canonical-display").display_agent, "Johnny5");
assert.equal(pane("metadata-canonical-display").agent_session.source, "herdr:letta");
checks.push("Metadata-only name visible with native identity intact");
for (const op of ["releaseAgent", "clearAgentAuthority"]) {
  assert.equal(pane(`${op}-after-idle`).agent_status, "working");
  assert.equal(pane(`${op}-after-idle`).agent_session.source, "herdr:letta");
}
checks.push("Mod-first stays working despite later idle report after native identity");
assert.equal(pane("releaseAgent-after-teardown").agent_session.source, "herdr:letta");
assert.equal(pane("clearAgentAuthority-after-teardown").agent_session, undefined);
checks.push("Release preserves native identity; clear deletes it");
assert.equal(get("cleanup-both-display-clear").ok, true);
assert.equal(get("cleanup-both-display-clear").response.error.code, "invalid_metadata_request");
assert.equal(get("reporter-rejected-snapshot").lastResultOk, true);
checks.push("Server rejection is falsely reported as client/reporter success");
for (const id of ["conv-B", "conv-C", "default:agent-B"]) {
  assert.equal(pane(`native-switch-result-${id}`).agent_session.value, "default:agent-research");
}
checks.push("Native same-process identity replacements ignored");
assert.equal(pane("unguarded-clear-result").tokens?.summary, undefined);
checks.push("Summary token deleted despite presentation source guard");
assert.equal(get("cleanup").rootRemoved, true);
assert.equal(get("cleanup").onlyCreatedServerStopped, true);
checks.push("Isolated server cleanup completed");
console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), rawEvidence: file, checks }, null, 2));
