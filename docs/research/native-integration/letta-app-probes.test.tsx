// Run from the pinned Letta source clone; see letta-app-results.md.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { __testSetBackend } from "@/backend";
import { setConfiguredBackendMode } from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { createAssistantMessageStream } from "@/backend/dev/headless-turn-executor";
import { App } from "@/cli/App";
import { settingsManager } from "@/settings-manager";
import { isQueueBridgeConnected } from "@/utils/message-queue-bridge";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(p: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (p()) return; await sleep(25); }
  throw new Error(`Timeout: ${label}`);
}
class Output extends Writable {
  columns = 120; rows = 40; isTTY = true; text = "";
  _write(chunk: any, _encoding: any, callback: any) { this.text += chunk.toString(); callback(); }
}
test("actual App contract probe with fake backend and observer mod", async () => {
  // bun's upstream test preload has already redirected os.homedir and HOME.
  const home = process.env.LETTA_TEST_HOME!;
  if (!home || home === "/root") throw new Error("Disposable test home required");
  process.chdir(home);
  const networkAttempts: string[] = [];
  globalThis.fetch = (async (url: any) => {
    networkAttempts.push(String(url)); throw new Error("Network disabled in contract probe");
  }) as any;
  const root = join(home, ".letta");
  const eventsPath = join(home, "events.jsonl");
  const hooksPath = join(home, "hooks.jsonl");
  mkdirSync(join(root, "mods"), { recursive: true });
  writeFileSync(join(root, "mods", "observer.ts"), `import { appendFileSync } from 'node:fs';
export default function(letta) {
 const names = ['conversation_open','conversation_close','turn_start','turn_end','tool_start','tool_end','llm_start','llm_end'];
 const ds = names.map(name => letta.events.on(name, (event, ctx) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({name,event,agent:ctx.agent,sessionId:ctx.sessionId})+'\\n')));
 return () => ds.forEach(d => d());
}`);
  const hookProgram = join(home, "hook.cjs");
  writeFileSync(hookProgram, `let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>require('fs').appendFileSync(${JSON.stringify(hooksPath)},s.trim()+'\\n'));`);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{type: "command", command: `node ${hookProgram}`}]}] } }));
  setConfiguredBackendMode("local");
  await settingsManager.reset(); await settingsManager.initialize();
  let calls = 0; let aborted = false;
  const backend = new FakeHeadlessBackend("agent-contract-probe", {
    async execute() {
      calls++;
      if (calls !== 2) return createAssistantMessageStream();
      const controller = new AbortController();
      return { controller, async *[Symbol.asyncIterator]() {
        if (!controller.signal.aborted) await new Promise<void>(r => controller.signal.addEventListener("abort", () => r(), {once:true}));
        aborted = true;
      }} as any;
    }
  });
  __testSetBackend(backend);
  const agent = await backend.retrieveAgent("agent-contract-probe");
  const conversation = await backend.createConversation({agent_id:agent.id});
  const stdin = new Readable({read(){}}) as any;
  stdin.isTTY = true; stdin.setRawMode = () => stdin; stdin.ref = () => stdin; stdin.unref = () => stdin;
  const stdout = new Output();
  const records = (path: string) => existsSync(path) ? readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(x=>JSON.parse(x)) : [];
  const snapshots: any[] = [];
  const snapshot = (label: string) => snapshots.push({label, calls, events:records(eventsPath), hooks:records(hooksPath)});
  const instance = render(<App agentId={agent.id} agentState={agent} conversationId={conversation.id} systemInfoReminderEnabled={false}/>, {stdin, stdout:stdout as any, debug:true, patchConsole:false, exitOnCtrlC:false});
  async function submit(text: string) { await sleep(250); stdin.push(text); await sleep(100); stdin.push("\r"); await sleep(900); }
  try {
    await waitFor(isQueueBridgeConnected,"mount");
    await waitFor(()=>records(eventsPath).some(x=>x.name==="conversation_open"),"observer startup");
    await waitFor(()=>records(hooksPath).length===1,"startup hook"); snapshot("startup");
    await submit("normal fixture turn"); await waitFor(()=>calls===1,"normal executor"); snapshot("normal");
    await submit("cancel fixture turn"); await waitFor(()=>calls===2,"cancel executor"); stdin.push("\u001b");
    await waitFor(()=>aborted,"abort observed"); await sleep(500); snapshot("cancel");
    await submit("/new"); await waitFor(()=>records(hooksPath).length===2,"new hook"); snapshot("new");
    await submit(`/resume ${conversation.id}`); snapshot("resume");
    await submit("/reload"); snapshot("reload");
    await submit("/rename agent Contract Renamed"); snapshot("rename");
    await submit("after rename"); await waitFor(()=>calls===3,"renamed turn"); snapshot("after-rename");
    expect(snapshots[1].events.filter((x:any)=>x.name==="turn_end").length).toBe(1);
    expect(snapshots[2].events.filter((x:any)=>x.name==="turn_end").length).toBe(1);
    expect(snapshots[2].events.filter((x:any)=>x.name==="turn_start").length).toBe(2);
    expect(snapshots[3].events.slice(-2).map((x:any)=>[x.name,x.event.reason])).toEqual([["conversation_close","new"],["conversation_open","new"]]);
    expect(snapshots[3].hooks[1].is_new_session).toBe(true);
    expect(snapshots[4].events.length).toBe(snapshots[3].events.length);
    expect(snapshots[4].hooks.length).toBe(2);
    expect(snapshots[5].events.slice(-2).map((x:any)=>[x.name,x.event.reason,x.event.conversationId])).toEqual([["conversation_close","reload",conversation.id],["conversation_open","reload",conversation.id]]);
    expect(snapshots[5].hooks.length).toBe(2);
    expect(snapshots[6].events.length).toBe(snapshots[5].events.length);
    expect(snapshots[7].events.slice(-2).every((x:any)=>x.agent.name==="Contract Renamed")).toBe(true);
    expect((await backend.retrieveAgent(agent.id)).name).toBe("Contract Renamed");
  } finally {
    const transitions = snapshots.map((s,i)=>({ phase:s.label, executorCalls:s.calls,
      addedEvents:s.events.slice(i ? snapshots[i-1].events.length : 0).map(({name,event,agent,sessionId}:any)=>({name,conversationId:event.conversationId,reason:event.reason,stopReason:event.stopReason,agent,sessionId})),
      addedHooks:s.hooks.slice(i ? snapshots[i-1].hooks.length : 0), totalHooks:s.hooks.length }));
    writeFileSync(process.env.PROBE_RESULTS!, JSON.stringify({timestamp:new Date().toISOString(),sourceCommit:"6db64e8f533e9c13d81536410460b83ef06e3bc4",transitions,blockedFetchAttempts:networkAttempts},null,2));
    instance.unmount(); instance.cleanup(); __testSetBackend(null);
  }
}, 30000);
