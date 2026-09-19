# Provider-free Letta App contract probes

## Scope and result

2026-09-18, Linux, Bun 1.3.14, Letta Code v0.32.13 source commit `6db64e8f533e9c13d81536410460b83ef06e3bc4`.

Actual production `App` rendered by Ink against upstream `FakeHeadlessBackend`, synthetic TTY input/output, real discovered observer mod, real SessionStart child-process hook. No production source modifications. **1 test passed, 12 assertions, 0 failures (10.42 seconds).** Initial exploratory run also passed.

This is a production-App integration fixture, not an installed-CLI/bootstrap test, real terminal visual demonstration, Cloud/provider test, or Herdr coexistence test. No approval/question UI test was run.

## Empirical observations

| Action | Observed |
| --- | --- |
| Mount with existing conversation | One SessionStart, `is_new_session=false`; one `conversation_open`, reason `startup`; exact agent name in both payload and context. |
| Normal fake assistant reply | `turn_start`, then `turn_end` with `stopReason=end_turn`. |
| Start a hanging stream, press actual ESC through Ink input | Fake stream's abort signal observed; second `turn_start`, **no second `turn_end`** after cancellation settled. Subsequent commands succeeded. |
| `/new` | Close/open reason `new`, second SessionStart with `is_new_session=true` and new conversation ID. |
| `/resume <original-id>` | **No added SessionStart or close/open events**. Successful switch independently established by subsequent reload events identifying the original conversation. |
| `/reload` | Close/open reason `reload` for original conversation; **no additional SessionStart**. |
| `/rename agent Contract Renamed` | Fake backend name changed, but no observed lifecycle/turn/tool/LLM event. |
| Next normal turn | Both turn events carry `ctx.agent.name = Contract Renamed`. |

Additional finding: `/new`'s `conversation_open.event.conversationId` was the **new** ID, but `ctx.sessionId` was still the **old** ID. Prefer the event's explicit identity for that transition; do not assume event/context identity parity.

No `llm_*` events appeared; this fake backend is not a LocalBackend instance. This observation does not test genuine local-provider emission.

## Isolation and limits

- Started test subprocess with `env -i`, retaining only PATH, HOME=/tmp, telemetry-off and output path.
- Upstream test preload creates disposable HOME, patches `os.homedir()`, and cleans it afterwards. Test changes cwd to that disposable home; global mods/settings and fake backend state therefore stay isolated.
- All inference used `FakeHeadlessBackend` and a deterministic executor; no credentials were inherited.
- Global `fetch` was replaced before App mounting with a rejecting recorder. App attempted balance and agent-repository requests to api.letta.com; **all eight fetch attempts were intercepted before transport**, recorded in JSON. The fake backend alone does not eliminate ancillary HTTP attempts, so this guard matters.
- This was a fetch-level guard, not an OS-wide network namespace/firewall. No provider/Cloud transport was intentionally invoked; no real conversation was used.
- SessionStart command was a local Node program consuming JSON stdin and appending to a disposable log; no Herdr hook or socket connection involved.
- Negative event observations are bounded by fixture settling delays and subsequent successful actions; the cited source branches independently support them.

## Files and reproduction

- `letta-app-probes.test.tsx`: reproducible test source.
- `letta-app-results.json`: timestamped compact event/hook deltas and blocked fetch attempts (no conversation content or credentials).

Run from a disposable clone checked out at the pinned commit:

```sh
bun install --frozen-lockfile --ignore-scripts
cp /absolute/path/to/letta-app-probes.test.tsx src/cli/letta-contract-probe.test.tsx
env -i PATH="$PATH" HOME=/tmp LETTA_CODE_TELEM=0 \
  PROBE_RESULTS=/tmp/letta-app-results.json \
  bun test src/cli/letta-contract-probe.test.tsx
```

Dependencies installed only in `/tmp/letta-code-contract-audit` using declared Bun manager; no lifecycle scripts were run. Test run log: `/tmp/letta-background-SfnWjF/bash_56.log`.

## Source anchors

All Letta links below are pinned to the tested commit.

- [Existing production-App fake-backend test seam](https://github.com/letta-ai/letta-code/blob/6db64e8f533e9c13d81536410460b83ef06e3bc4/src/cli/tui-interrupt-queue-lifecycle.test.tsx#L230-L267)
- [Normal completion and turn_end](https://github.com/letta-ai/letta-code/blob/6db64e8f533e9c13d81536410460b83ef06e3bc4/src/cli/app/use-conversation-loop.ts#L1424-L1566)
- [Cancellation returns without turn_end](https://github.com/letta-ai/letta-code/blob/6db64e8f533e9c13d81536410460b83ef06e3bc4/src/cli/app/use-conversation-loop.ts#L1697-L1730)
- [Startup SessionStart](https://github.com/letta-ai/letta-code/blob/6db64e8f533e9c13d81536410460b83ef06e3bc4/src/cli/app/AppCoordinator.tsx#L1136-L1161)
- [New conversation events and hook](https://github.com/letta-ai/letta-code/blob/6db64e8f533e9c13d81536410460b83ef06e3bc4/src/cli/app/use-submit-handler.ts#L1857-L1937)
- [Direct resume omission](https://github.com/letta-ai/letta-code/blob/6db64e8f533e9c13d81536410460b83ef06e3bc4/src/cli/app/submit-navigation-commands.ts#L114-L225)
- [Reload](https://github.com/letta-ai/letta-code/blob/6db64e8f533e9c13d81536410460b83ef06e3bc4/src/cli/app/AppCoordinator.tsx#L2525-L2577)
- [Local-only LLM bridge](https://github.com/letta-ai/letta-code/blob/6db64e8f533e9c13d81536410460b83ef06e3bc4/src/cli/mods/local-backend-mod-events.ts#L6-L77)

## Remaining source-only claims

Approval classification versus real prompt lifecycle, permission callback context argument, plain-object LLM error formatting, Cloud errors, agent-selector/default/fork/clear paths, task background lifetime, crash cleanup, and Herdr authority/restore behavior were not exercised here. Do not mark those runtime-verified based on this fixture.
