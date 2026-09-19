# Metadata-only Herdr mod implementation plan

Status: implemented and independently reviewed on 2026-09-19; see [implementation evidence](METADATA_ONLY_EVIDENCE.md). No commit, installation or release performed.

Based on [issue #4](https://github.com/klittle32/letta-herdr-mod/issues/4) and the [verified investigation](research/native-integration/REPORT.md). Baseline: Herdr 0.9.1, Letta Code 0.32.13, current mod source equivalent to v0.2.1.

## Product boundary

Make this a small companion to native Herdr integration, not an alternative integration.

| Owner | Responsibilities |
|---|---|
| Native Letta SessionStart hook | Conversation identity, including agent-qualified default conversations |
| Herdr | Restore dispatch, semantic working/idle/blocked state, waits, notifications and completion badges |
| Our mod | Stable display name; optional expiring working-detail labels; read-only diagnostics |

**Hard invariant:** the shipped mod may write only its own presentation metadata. It must never report semantic state/session identity, release lifecycle authority, or clear authority. No legacy lifecycle mode.

Out of scope: fixing upstream conversation-switch or turn-end events, native restore defects, native hook installation, provider orchestration, pane management, permission decisions, background-job accounting, desktop UI, and additional publication/deployment automation. Record upstream defects separately; do not work around them by taking back ownership.

## Intended behavior

### Stable agent name — enabled by default

- Set Herdr `display_agent` from the current Letta agent, without changing its canonical harness identity (`agent: letta`).
- Precedence: nonblank `LETTA_HERDR_DISPLAY_AGENT` override, then a name from the current scoped event/context. Do not use a process-wide `AGENT_NAME` as the normal dynamic source: it can be absent or stale after switching agents.
- On `conversation_open`, prefer its explicit agent identity/name when context conflicts; our experiment proved that event conversation ID can be newer than `ctx.sessionId`. For other events, use documented identity fields and matching scoped context. Never combine a new agent ID with a known old context name.
- Track `(agentId, conversationId)` plus a local activation/context generation. Distinct agents' `default` conversations must not share local state.
- Refresh on supported conversation/turn/tool events; optional local LLM events may also supply context. Name-only changes participate in deduplication.
- An observed context switch with no valid name clears our previous name rather than carrying it forward. Missing data within the same known context need not erase a valid name. An explicit configured override remains valid across contexts.
- Sanitize control characters and enforce Herdr's actual length constraints, including non-ASCII names.
- Use a dedicated name metadata source, canonical agent guard, and **no `applies_to_source`**. Do not set title or custom tokens.
- Keep name metadata independent of activity expiry. Clear our name on observed close/disposal; native process-exit handling provides additional cleanup.

**Known limit:** current Letta does not emit every switch/rename event. An idle rename or unobserved switch may remain stale until the next supported event. `agent: letta` guards the harness, not the individual conversation. Document this; do not add polling, hidden panels or private-runtime imports to disguise it.

### Optional activity detail — off by default

- Introduce `LETTA_HERDR_ACTIVITY_DETAIL=1`; default off.
- Introduce `LETTA_HERDR_ACTIVITY_TTL_MS`, default **30000 ms**, validated against Herdr's positive bounded TTL range. No infinite/zero-TTL detail mode.
- Use a separate activity metadata source and only `state_labels.working`—no generic `summary` token, no idle/blocked/done labels.
- Suggested labels: `processing` on turn start/tool end, `tool:<name>` on tool start, and `thinking` on actual local `llm_start`.
- Cloud agents do not emit the local LLM events; use supported turn/tool events rather than pretending Cloud model telemetry exists.
- Maintain a small active-tool-ID set so one parallel tool finishing does not erase another active tool's label. For multiple tools use a bounded aggregate label. Tool return is not background-job completion.
- Clear activity on observed turn end, conversation change/close, disposal, and explicit model error. Handled tool errors do not become semantic blocked states.
- Every activity update carries server TTL. Repeated observations may refresh it even if the label is unchanged. Do not run a heartbeat or infer completion from elapsed time.
- If cancellation/turn-end is missed, the label expires. If a real tool runs longer than the TTL without another event, the label may disappear; native semantic state remains untouched. A missing label never means the work completed.
- Do not resend stale activity merely because a later name-only event occurred.

### Read-only diagnostics

- Retain `/herdr-status`; remove `/herdr-repair` and the permission observer entirely.
- `/herdr-status` performs bounded read-only lookup of the calling pane. It must not publish metadata, focus the pane, install hooks, refresh names or repair anything as a side effect.
- Show enabled/disabled reason, pane, expected name, observed display name, semantic state, native session reference when present, activity setting/TTL, and last transport/server error.
- Distinguish local intent, a valid RPC acknowledgement and actual read-back. Matching display text is not proof of which metadata source won. Do not claim exact authority/source ownership when the read API does not expose it.
- Warn when native session identity is absent; when enough scoped identity exists, flag a mismatch without changing it. This catches symptoms, not every upstream restore issue.
- Keep output short; no transcripts, tool arguments, output payloads or provider error bodies.

## Implementation slices

Every slice follows tests first, expected red result, smallest passing change, and relevant/full verification. Keep the existing repository/package; do not introduce a framework, dependencies, or new managed-mod distribution scheme.

### 1. Narrow and harden the socket client

**Files:** `src/herdr-client.ts`, `test/herdr-client.test.ts`.

- Replace lifecycle-oriented methods/types with metadata presentation writes and pane read-back.
- Remove `reportAgent`, session payload support, `releaseAgent`, and `clearAgentAuthority` from the production client.
- Make clear requests explicit; they must never inherit display-name defaults or simultaneously set and clear the same field.
- Validate response envelope, request correlation and server errors. Malformed JSON, unexpected envelopes, socket close without a response and timeout are failures—not successes.
- Preserve bounded requests and add a bounded response buffer. Do not add broad retry/backoff machinery.
- Admit that some well-formed Herdr success responses mean ignored/no-op; read-back is separate.
- Derive stable, distinct name/activity source IDs from the existing configured source prefix within server limits, without truncation collisions. Do not reuse the old combined presentation source.

**Red tests:** server error envelope, malformed/unexpected/wrong-ID response, disconnect, oversize response, invalid set-and-clear, distinct bounded sources, correct metadata guard, read-only pane request. Assert emitted traffic never uses lifecycle/session/authority endpoints.

### 2. Replace the semantic state reporter with a presentation reporter

**Files:** replace `src/state-reporter.ts`/tests with `src/metadata-reporter.ts`/tests; update imports only as needed.

- Implement the name and activity rules above; delete semantic idle debounce, stale-working timers, watchdogs, approval blocked state, and error-to-blocked logic.
- Serialize writes per activation. Capture immutable payload and generation at enqueue time; discard obsolete queued work after observed context changes/disposal.
- Disposal stops accepting events and orders owned-source clears after admitted writes. Never use lifecycle release as cleanup.
- Prevent old activation cleanup from racing a replacement instance into a persistent missing-name state. Validate reload ordering against the actual harness; use narrow per-activation source separation with bounded expiry for obsolete data, or another tested ordering mechanism if shared stable sources cannot be made safe. No unbounded proliferation of metadata sources.
- Keep read-back and local desired-state diagnostics distinct. Never deduplicate a failed write as successfully applied.

**Red tests:** configured override, Unicode/sanitization, rename-only update, absent name, observed agent/default-context switch, stale context mismatch, parallel tools, missing IDs, activity disabled, TTL refresh versus dedup, expiry without semantic mutation, late callbacks, inflight close/reload, failed write retry, clear payload isolation, no foreign token/source changes.

### 3. Rewire supported Letta events and diagnostics

**Files:** `src/index.ts`, `test/index.test.ts`.

- Guard each event/command on host capabilities; keep handlers observational and return no tool/turn transforms.
- Read scoped context from documented callback arguments. No permission overlay remains, so classification is no longer interpreted as UI state.
- Remove the module-global mutable reporter bundle; commands and disposer close over their activation-owned instance.
- Register only the supported events needed for name/activity and `/herdr-status`.
- Include a runtime contract test with structured LLM errors and current public event payloads—not just hand-built idealized mocks.
- For missing capabilities, degrade predictably: native behavior continues; diagnostics explain which niceties cannot refresh. Outside Herdr, perform no IPC.

**Red tests:** event mapping, optional capability matrix, Cloud without LLM events, local error shape, callback context identity, status sends only reads, status does not claim an ignored write applied, removed repair command/overlay, disposal and reactivation.

### 4. Prove native coexistence in the isolated integration harness

Promote a focused subset of the research probes into maintainable integration tests. Keep external Herdr binary tests separate from ordinary unit gates and skip with a clear reason when the pinned binary is unavailable. Network/provider access is not required.

Required acceptance cases:

1. Native-first and mod-first ordering yield identical native lifecycle/identity; the new mod sends presentation only.
2. Explicit name appears while native working/blocked/idle transitions continue unchanged.
3. Activity TTL expires during long work without changing semantic state or the stable name.
4. Observed conversation changes, two agents' default contexts, missing names, override and rename update safely.
5. Closing/reloading the mod preserves native restore identity and unrelated presentation/tokens.
6. Error responses and ignored guards are not presented as verified application.
7. Reload/inflight ordering cannot let disposed work resurrect obsolete presentation.
8. Actual isolated cold restart still dispatches correct named/default native resume commands after new-mod use.
9. Production Letta App fixture exercises cancellation, new/resume/reload and next-event rename with the actual companion mod enabled. Missing upstream events remain documented limits; no tests should assert that we fixed them.

Keep source-backed conclusions separate from full TUI/provider acceptance. Tests do not certify authenticated resume, every permission/question UI or Windows IPC.

### 5. Document migration and prepare a separately approved release

**Files:** README, configuration table, migration notes, package version/release notes when release scope is approved.

- Explain one owner per responsibility and the upstream event/identity caveats.
- Document required Herdr/native hook setup as operator steps; never auto-install it.
- Keep `LETTA_HERDR_DISPLAY_AGENT`, source prefix and the two new activity options. Remove lifecycle state/agent overrides, idle/stale/watchdog/approval options. Detect retired settings and warn once rather than silently implying they still work.
- Document that `/herdr-repair` was removed for safety. `/herdr-status` is strictly read-only.
- Recommend a **fresh Letta process/pane**, not only `/reload`, when moving from the old lifecycle mod. Prevent the old mod from loading into the fresh process. No Herdr server restart is required.
- Verify native identity, working/idle/blocked behavior, display name and cleanup before declaring migration complete. A preexisting custom authority must be safely released and read back if the operator chooses an in-place migration. Never clear native authority/identity automatically, and never use the old repair command as migration.
- Treat this as a breaking behavioral change; recommend the next minor pre-1.0 release (`v0.3.0`, subject to current tags). Reconcile the stale package manifest version at that point.
- Production installation, commit/merge/push, tagging and upstream issue filing require their own authorization. Until then leave tested changes in the worktree.

## Definition of done

- Production write surface contains only presentation metadata; no semantic/session/authority mutation methods or permission observer.
- Name works independently of optional transient detail, with documented event-refresh limits.
- Native identity and state survive both startup orders and teardown; unrelated metadata is preserved.
- All unit/type/build gates and pinned isolated integration tests pass; independent boundary review has no blockers.
- Diagnostics report actual read-back truth and never mutate state.
- Migration guidance addresses existing old authority rather than assuming metadata-only code removes it.
- No upstream defect is hidden behind a new ownership workaround or a false claim of complete platform coverage.

## Suggested execution order

Implement slices 1–3 sequentially as one small product change, then run the decisive native-coexistence gates in slice 4 before finishing docs in slice 5. Parallelize independent review only; shared client/reporter/event contracts are small enough that multiple simultaneous implementers would add coordination risk without much benefit.
