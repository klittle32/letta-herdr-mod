# Native Letta integration and letta-herdr-mod coexistence

Investigation for [issue #4](https://github.com/klittle32/letta-herdr-mod/issues/4), 2026-09-18.

## Recommendation

Keep Herdr's native Letta integration responsible for conversation identity and restore, and its screen/OSC detector responsible for semantic lifecycle. Reduce our mod to **presentation metadata and read-only diagnostics**. Keep explicit `ctx.agent.name` as the display name; optionally add short, expiring working-detail labels.

Do not run the existing full reporter alongside native identity and assume they are independent. Their interaction is order-sensitive. Do not use `/herdr-repair` in a combined setup until its authority-clearing behavior is removed or corrected. Do not impersonate `herdr:letta` to work around ownership checks.

This investigation changes no production mod code, user configuration, or Mac session. Research probes are separate from production tests. Implementation and upstream publication remain separate decisions.

## Version and evidence boundary

| Component | Pinned evidence |
|---|---|
| Herdr | v0.9.1, `065ef9d6a531c49fb8bee7e818ef837065b21ee9` |
| Letta Code | installed 0.32.13; matching source `6db64e8f533e9c13d81536410460b83ef06e3bc4` |
| Mod | main `339e6550423ea97659b4f3e9e602854e7a671231`; source identical to v0.2.1 commit `e10d4e40bab8af9999da78a332392967199cce4a` |
| Sandbox | Linux x86_64, kernel 6.19.14; Node 22.23.2; Bun 1.3.14 |
| Existing mod gates | `bun install --frozen-lockfile`; `bun run check`: 45 tests, 117 assertions, typecheck/build passed |

Evidence types must remain distinct: source tracing, direct reporter/hook probes, actual Herdr RPC experiments, production-App fixtures, and authenticated end-to-end restore are not interchangeable. Linux evidence does not certify macOS or Windows behavior.

## Executed evidence matrix

| Area | Native-only | Existing mod-only | Both / complementary |
|---|---|---|---|
| Named/default identity | Actual Unix hook: six serialization/silence cases passed; real server retained qualified default | Custom IDs discarded by server contract | Native identity admission changes custom lifecycle acceptance |
| Basic state | Real Herdr server published fixture working, blocked and idle after 2.2-second settlement; explain matched | Existing 45-test suite passed; direct reporter probes passed | Real-server ordering probes reproduce ignored transitions and frozen custom state |
| Normal completion / cancellation | Production Letta App fixture: normal end emitted; ESC cancellation emitted no end | Missing end can leave reporter working after tool use (scaled probe) | Do not use mod events as a complete replacement for native readiness |
| `/new`, `/resume`, `/reload` | Production App: new emits hook/events; successful direct resume emits neither; reload emits events but no hook | Reporter depends on incomplete transition surface | Same-owner native identity replacement has an additional Herdr-side rejection |
| Name / rename | Hook ignores name; title-only display available by config | Name-only change deduplicated; absent name can retain old identity | App fixture confirms rename emits no subscribed event, next turn has new name; metadata-only request can show Johnny5 |
| Cleanup | Native record survives custom release | Environment name can create rejected set-and-clear request | Real-server clear-authority probe removes coexisting native identity |
| Errors / diagnostics | RPC can acknowledge ignored requests | Server error response treated as success; retry can be deduplicated | Read-back required before claiming effective state |
| Permissions/questions | Manifest/OSC and source inspected | Classification is not prompt-open; exact callback mismatch found | Full approval/denial/question UI matrix not executed |
| Restore | Actual isolated cold restart dispatched correct named/default argv to capturing fixtures; two default agents stayed distinct | No accepted restore identity | Authenticated Letta resume/reconnect not executed |

Production-App fixture details and compact event evidence: [letta-app-results.md](letta-app-results.md), [letta-app-results.json](letta-app-results.json). The fixture uses the actual App/Ink input and a deterministic fake backend, not paid/provider turns. Ancillary fetches were intercepted and rejected before transport.

Real-server experiment details: [runtime-findings.md](runtime-findings.md). The parent independently reran the final isolated harness and asserted eleven grouped read-back checks, recorded in [runtime-verification.json](runtime-verification.json). Both client and server were 0.9.1; bundled manifests were pinned with remote manifest checks disabled. The earlier short-settlement unknown snapshots were not counted as successful state transitions.

## Responsibility map

| Concern | Native implementation | Existing mod | Recommended complement |
|---|---|---|---|
| Identity | Quiet SessionStart hook, official source `herdr:letta` | Sends conversation ID on custom lifecycle source; Herdr discards that ID | No identity writes |
| Default conversation | `default:<agent-id>` | Sends raw `default`, not accepted as restore identity | Native only |
| Restore | `letta --conversation <id>`; default also supplies `--agent` | No recognized restore plan | Native only |
| Lifecycle | OSC title/progress plus visible-screen manifest | Event-driven state and timers | Native only |
| Approval/questions | Visible/OSC blocker evidence | Opt-in permission classification, not actual dialog lifecycle | Native only; no synthetic blocked state |
| Agent name | Hook ignores available `agent_name`; default sidebar uses harness name | Explicit name from mod context | Retain stable explicit display name |
| Activity detail | Detection evidence, not individual tool metadata | `thinking`, `tool:<name>`, `ready` | Optional presentation-only working detail |
| Diagnostics | Herdr reads/explain | Local attempted-report snapshot, sometimes false success | Parse errors and read back actual state |
| Teardown | Native process/session handling | Release or clear authority plus metadata deletion | Only clear/expire our presentation |

## Confirmed source contracts and collisions

### 1. Alias compatibility is not the problem

Herdr accepts `letta`, `letta-code`, and `letta code`, and canonicalizes API agent labels to `letta`. Source IDs are not aliases: `letta-code:mod` is a different owner from `herdr:letta`.

Sources: [agent normalization](https://github.com/herdrdev/herdr/blob/v0.9.1/src/app/api_helpers.rs#L191-L199), [detection and authority lists](https://github.com/herdrdev/herdr/blob/v0.9.1/src/detect/mod.rs#L327-L346).

### 2. Native identity changes whether mod lifecycle reports are accepted

Only official source/agent pairs may create session references. The custom mod's attached conversation IDs are discarded before state handling. Therefore its raw `default` is **absent restore support**, not proof of a persisted collision between default conversations.

The lifecycle handler checks existing identity ownership. A custom reporter cannot take over an official native session because it has no accepted session reference or native restore plan.

- **Native first:** later custom lifecycle reports can be ignored, while RPC returns ordinary success. The mod's `applies_to_source: letta-code:mod` presentation guard then has no matching lifecycle authority, so its display name/state labels can be hidden.
- **Mod first:** it can establish custom authority without a session reference. Native identity can subsequently be recorded alongside that authority. Later custom lifecycle reports conflict with native identity and are ignored. The old custom state can remain authoritative; continuing metadata updates do not prove lifecycle transitions are applying.

Sources: [session admission](https://github.com/herdrdev/herdr/blob/v0.9.1/src/agent_resume.rs#L53-L69), [authority admission](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/state.rs#L645-L749), [identity owner comparison](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/state.rs#L1237-L1297), [takeover requirements](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/state.rs#L1649-L1670).

### 3. Screen blockers can override custom state—but screen completion is not a general escape hatch

Our source is not one of Herdr's special full-lifecycle authorities. A fresh visible blocker for the same detected agent can override a custom nonblocked state. It is incorrect to claim our mod suppresses all native approval detection.

However, ordinary screen working/idle does not similarly override an effective custom hook state. A custom blocked report is not automatically cleared by a later idle screen. This makes stale mod authority operationally dangerous for waits and orchestration.

Sources: [blocker exception](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/state.rs#L1858-L1868), [effective-state selection](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/state.rs#L2156-L2172).

### 4. Repair is more destructive than release

Custom `release_agent` preserves a foreign persisted native session and removes matching custom authority; it preserves screen fallback when Herdr still detects the agent process. Otherwise fallback can reset to unknown. A matching `clear_agent_authority` clears the custom hook **and unconditionally clears persisted session identity**, including a coexisting native record. The source filter does not make this operation identity-safe.

The mod's extra `agent_session_id` on release is not a supported conversation-generation guard. Async old-mod cleanup and new-mod reports can overlap across reload.

Sources: [clear versus release](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/state.rs#L1691-L1808), [mod cleanup](https://github.com/klittle32/letta-herdr-mod/blob/e10d4e4/src/state-reporter.ts#L205-L238).

### 5. Presentation fields and tokens have different ownership

`display_agent`, title and state labels are stored per metadata source. `agent` guards against the effective harness; `applies_to_source` guards against **lifecycle authority**, not persisted native session identity. A metadata-only complement must omit `applies_to_source`, not change it to `herdr:letta`.

Ordinary presentation updates replace the source's whole presentation snapshot. Omitted fields disappear. Clear-flag requests have different merge/clear semantics. Send complete intentional snapshots.

Tokens such as `summary` are a single pane-global map. They are not protected by the presentation guards or owned by the metadata source. Another reporter's `summary` can be overwritten or deleted by our cleanup. Prefer no custom token initially; if needed, reserve a distinct key such as `letta_mod_detail` and document that it remains global.

Sources: [API token patch versus presentation dispatch](https://github.com/herdrdev/herdr/blob/v0.9.1/src/app/api/panes.rs#L1680-L1753), [presentation guards/replacement](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/metadata.rs#L129-L263), [global token storage](https://github.com/herdrdev/herdr/blob/v0.9.1/src/metadata_tokens.rs#L10-L65).

### 6. Cleanup and diagnostics currently overstate success

When the client has an environment-derived display name, cleanup sends both `display_agent` and `clear_display_agent`. Herdr rejects that combination as `invalid_metadata_request` before applying the request. A name supplied only through reporter context does not necessarily trigger this case.

The mod treats any received line, including a server error JSON object, as transport success. Herdr also legitimately returns success for some ignored/stale reports. Consequently `/herdr-status` is not evidence of applied state. `clearAuthority()` can additionally return success after metadata cleanup fails while recording failure only in its local snapshot.

Sources: [metadata conflict validation](https://github.com/herdrdev/herdr/blob/v0.9.1/src/app/api/panes.rs#L1643-L1651), [mod wire construction/error handling](https://github.com/klittle32/letta-herdr-mod/blob/e10d4e4/src/herdr-client.ts#L178-L222).

## Native implementation gaps—not reasons to retain competing lifecycle code

### Session replacement has two separate missing links

1. **Herdr:** Letta is absent from the allowed same-owner replacement table. A different ID under `herdr:letta` can be rejected even with `session_start_source=new/resume` while the previous identity remains. Fresh process cleanup is a different case.
2. **Letta:** not every in-process navigation path emits SessionStart or mod close/open events.

Source-backed Letta 0.32.13 TUI successful-path matrix (not a headless/SDK contract):

| Path | SessionStart | Mod conversation close/open |
|---|---|---|
| Initial launch, explicit resume/default launch | Yes | startup open |
| `/new`, `/fork`, `/clear` | Yes, new | Yes |
| `/reload` | No | Yes, reload |
| Direct `/resume <id>` | No call in path | No calls in path |
| Selector/queued resume | No call in path | No calls in path |
| Agent selection | No call in path | No calls in path |
| `/btw` jump | Yes, new flag despite resume reason | Yes |

Sources: [Herdr replacement policy](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/state.rs#L1320-L1351), [Letta startup](https://github.com/letta-ai/letta-code/blob/6db64e8/src/cli/app/AppCoordinator.tsx#L1136-L1201), [direct resume](https://github.com/letta-ai/letta-code/blob/6db64e8/src/cli/app/submit-navigation-commands.ts#L114-L225), [agent/conversation switching](https://github.com/letta-ai/letta-code/blob/6db64e8/src/cli/app/use-conversation-switching.ts#L350-L662).

The production-App fixture independently reproduced startup, normal turn, ESC cancellation, `/new`, successful direct `/resume`, `/reload`, rename and next-turn naming. It also found `/new`'s open event carrying the new conversation ID while `ctx.sessionId` still carried the old one. Prefer explicit event identity at that boundary. Agent-selector/fork/clear/default navigation paths remain source-only in this investigation.

### Restore is a launch recipe, not universal environment reconstruction

Native restore builds named/default CLI arguments and distinguishes default agents correctly. It does not preserve arbitrary original launch flags such as backend selection. Successful identity capture is not proof that credentials, selected backend, missing/deleted conversations, or provider access will permit an authenticated restart. Windows PowerShell hook execution and its one-second job timeout need platform-specific evidence.

We also executed actual Herdr cold restart against argv-capturing `letta` fixtures. The named pane launched `letta --conversation conv-research`; default panes separately launched `letta --conversation default --agent agent-A` and `--agent agent-B`. All retained their own persisted identities; no default-agent deduplication collision. This proves restart dispatch, not authenticated conversation recovery. Details: [runtime-restore-findings.md](runtime-restore-findings.md).

The parent independently repeated this cold restart, asserted all three distinct launch commands, and verified cleanup. No research servers or fixture processes remained afterwards.

Sources: [restore argument construction](https://github.com/herdrdev/herdr/blob/v0.9.1/src/agent_resume.rs#L228-L246), [Windows hook](https://github.com/herdrdev/herdr/blob/v0.9.1/src/integration/assets/letta/herdr-agent-session.ps1).

## Letta event limitations affecting our current mod

- `llm_start`/`llm_end` are wired only for `LocalBackend`; they are not general Cloud inference telemetry.
- TUI `turn_end` is emitted in the normal completion path, not an unconditional finally. Cancellation, veto, and errors have paths without it.
- After tool start cancels the stale timer, tool end does not rearm it. Missing turn end can leave `working` indefinitely with default watchdog settings.
- Conversely, a long model operation can hit the default five-minute stale timer and falsely become idle.
- Permissions use `check(event, context)`, not `event.context`. The `approval` phase is classification, not proof a prompt opened, and can apply to automatically allowed tools.
- There are no public precise question/permission opened/resolved/denied/cancelled mod events in this version.
- Real `llm_end.error` is a structured object. Our formatter emits `[object Object]` for it.
- A background tool's returned task ID is not completion of its underlying job. Neither our current state nor native ready-for-input state should be interpreted as “all background jobs finished.”
- Display-name and error-message changes are absent from reporter deduplication. An absent new name retains the previous name; the explicit environment override loses to a context name.

Sources: [local LLM adapter](https://github.com/letta-ai/letta-code/blob/6db64e8/src/cli/mods/local-backend-mod-events.ts#L6-L77), [normal turn completion](https://github.com/letta-ai/letta-code/blob/6db64e8/src/cli/app/use-conversation-loop.ts#L1424-L1566), [cancellation](https://github.com/letta-ai/letta-code/blob/6db64e8/src/cli/app/use-conversation-loop.ts#L1697-L1730), [error/finally](https://github.com/letta-ai/letta-code/blob/6db64e8/src/cli/app/use-conversation-loop.ts#L2814-L2880), [permission interface](https://github.com/letta-ai/letta-code/blob/6db64e8/src/mods/types.ts#L617-L651), [error shape](https://github.com/letta-ai/letta-code/blob/6db64e8/src/mods/types.ts#L293-L319).

## Agent name: keep the useful part

The native SessionStart payload already contains `agent_name`, but Herdr's bundled hook does not consume it. Herdr's default sidebar does not select terminal title tokens. A config-only alternative is:

```toml
[ui.sidebar.agents.rows_by_agent]
letta = [["state_icon", "workspace", "tab"], ["terminal_title_stripped"]]
```

That is only a title presentation, not a stable identity. Herdr strips one recognized leading spinner; it does not transform `[ ! ] Action Required | ...` back into a pure agent name. Explicit display metadata from `ctx.agent.name` is therefore a justified complement for Kyle's preference.

Sources: [sidebar tokens](https://github.com/herdrdev/herdr/blob/v0.9.1/docs/next/website/src/content/docs/configuration.mdx), [title stripping](https://github.com/herdrdev/herdr/blob/v0.9.1/src/terminal/title.rs#L1-L25), [SessionStart payload](https://github.com/letta-ai/letta-code/blob/6db64e8/src/hooks/index.ts#L367-L408).

## Small complementary design

1. Native hook: identity only; native Herdr detector: lifecycle and blocked state.
2. Mod: canonical `agent: letta`, private metadata source, **no `applies_to_source`**.
3. Keep `display_agent`; optional `state_labels.working` is presentation only. Do not relabel blocked/idle/done from speculative events.
4. Do not invoke lifecycle, session, release, or clear-authority APIs in complementary mode.
5. Send complete presentation snapshots. Bound transient detail with expiry; expiry removes a label, never declares work finished. Keep stable name and transient detail in separate sources if they need different lifetimes.
6. Serialize writes, invalidate callbacks on conversation/generation changes, and include name in deduplication. Handle absent names without leaking the previous agent's identity. Define override precedence explicitly.
7. Cleanup clears only owned presentation sources/explicit reserved token keys; never both set and clear the same field.
8. Diagnostics distinguish connection, valid server response, and observed application. Read effective agent, native session reference and display metadata without mutating lifecycle.
9. Do not claim live rename/switch coverage beyond available events. A narrow upstream name/context-change event is preferable to a polling framework.

The `agent: letta` guard distinguishes harnesses, not individual Letta agents/conversations. Missed in-process switches can retain the previous display name until a reliable context refresh or cleanup. Local generation invalidation only protects transitions actually observed.

**Migration gate:** enabling metadata-only mode does not remove existing custom lifecycle authority. Validate migration in a fresh process/pane, or explicitly verify the old authority was safely released and native identity preserved. Do not use repair/clear-authority as the migration mechanism. No production migration was attempted here.

Small implementation acceptance gate: both native/mod startup orders; named/default agent A/B; name present/absent/renamed/overridden; complete snapshot replacement; TTL expiry during long work; cleanup/reload with inflight writes; native session survives cleanup; server errors visible; stale/no-op reports not misrepresented as applied.

## Reproducible parent probes

```sh
bun docs/research/native-integration/reporter-probes.ts
bun docs/research/native-integration/native-hook-probes.ts /path/to/herdr-v0.9.1-source
bun docs/research/native-integration/runtime-probes.ts
bun docs/research/native-integration/verify-runtime-results.ts
bun docs/research/native-integration/runtime-restore-probes.ts
```

`reporter-probes.ts` executes the shipped reporter/client with recording transports, asserting timer, deduplication, error-shape, override and partial-cleanup outcomes. Timers are scaled; this is not a five-minute wall-clock stress test.

`native-hook-probes.ts` executes the real Unix hook with a recording Herdr CLI. Six cases passed: named new/resume, distinct default agents A/B, invalid default without agent, empty conversation. All paths were silent. This verifies hook serialization, not SessionStart emission or restore execution.

The production-App fixture was independently rerun by the parent investigator: 1 test, 12 assertions passed in 10.41 seconds. Its observed transitions matched the worker's 10.42-second run. Independent source review found no blockers in the central conclusions; its scope, fallback, name-staleness and migration cautions are incorporated above.

## Targeted upstream proposals (drafts, not filed)

- **Herdr:** allow and test native Letta same-owner `new`/`resume` identity replacement.
- **Herdr:** preserve foreign persisted identity when clearing custom lifecycle authority, consistent with release semantics.
- **Letta:** emit consistent conversation transition/SessionStart coverage for direct resume, selector resume and agent changes.
- **Letta:** make turn end/error/cancel semantics complete, and expose actual permission/question lifecycle rather than classification inference.
- **Herdr:** document identity-only/native/custom lifecycle coexistence, presentation guard semantics, global token keys and success-versus-applied behavior. A session-identity metadata guard would be useful but is not required for the smallest complement.
- **Optional Herdr enhancement:** native display-name metadata using the already supplied `agent_name`; still needs rename/transition handling. This could eventually eliminate the name-only part of our mod.
