# Isolated Herdr 0.9.1 runtime probes

## Environment and reproduction

Tested 2026-09-18 in Cloud Linux x86_64 (kernel 6.19.14), Bun 1.3.14. Public `herdr-linux-x86_64` v0.9.1 binary reports protocol 22 / endpoint generation 1. Release API SHA-256 and downloaded binary both equal `2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7`.

Run `bun docs/research/native-integration/runtime-probes.ts` from this worktree. Requires gcc, the verified `/tmp/herdr-v0.9.1-research` binary, and v0.9.1 source at `/root/workspace/herdr`. Raw JSON is written to `/tmp/herdr-issue4-runtime-results.json`; stdout has the same labeled records. The harness imports the actual mod client/reporter, invokes the actual native shell hook, and sends actual socket RPCs to a named headless server.

Every run creates a temporary HOME, XDG config/data/state/runtime directories, explicit config, and `issue4-runtime` named server. It does not inherit provider credentials or Herdr socket selectors. The final harness sets `[update] manifest_check = false` to pin bundled detection. Earlier runs fetched manifest version `2026.08.24.1`, the same version as the pinned source; see raw `agent-explain` for exact provenance. No production config or product code changed.

**This is a fixture-backed integration test, not a real Letta TUI or provider turn.** The disposable C executable is named `letta`, takes no arguments, emits an idle composer and controlled OSC titles, and waits for input. Herdr identifies it as `agent: letta`. Initial sleep fixtures were insufficient (positional duration arguments prevented interactive agent recognition); conclusions below use the recognized no-argument fixture. No screenshot/rendered-sidebar claim is made.

## Observations

| Probe | Actual result |
| --- | --- |
| Native shell hook with `conversation_id=default`, `agent_id=agent-research` | Silent exit 0; persisted session is `default:agent-research`, source `herdr:letta`, canonical agent `letta`. |
| Fixture native-only working → blocked → idle | With 2.2-second settlement, `pane get` reports working, blocked, idle respectively. `agent explain` matches `osc_title_working`, `osc_title_blocked`, `composer_idle`. At 650 ms, earlier snapshots were still unknown: explanation matching alone was insufficient. |
| Native first, mod working second | Mod RPC returns `{result:{type:"ok"}}` but idle state and native session remain. Mod summary token does change. Native identity is not overwritten by the mod's bare `default`. |
| Mod working first, native session second, mod idle third | Mod working initially applies; native session appears; subsequent mod idle returns success but pane remains working. This is an ordering/authority conflict, not proof that the mod events failed to fire. |
| Mod `releaseAgent` after preceding order | Clears custom lifecycle authority; native session remains. |
| Mod `clearAgentAuthority` after preceding order | Clears custom lifecycle authority **and removes native persisted session**. This is materially different from release. |
| Native same-pane replacement | Fresh sequenced `conv-B/resume`, `conv-C/new`, and `default:agent-B/new` session reports all return success but keep `default:agent-research`. This tests same-process replacement, not a fresh process lifecycle. |
| Current client's metadata-only call under native identity | Summary changes, but Johnny5 name is absent because the client's `applies_to_source=letta-code:mod` guard does not match native authority. |
| Raw metadata-only `agent=letta`, source `research:metadata`, no applies-to-source | Displays `Johnny5` while retaining native idle lifecycle/session. No lifecycle RPC is necessary for this name change. |
| Wrong agent (`claude`) or wrong applies-to-source | Does not replace the displayed name; returns normal RPC success. |
| Canonical metadata over an active mod lifecycle | `Johnny5-canonical` displays; clearing **that metadata source only** reveals the underlying mod source's `Johnny5`. Agent aliases work with the existing client when lifecycle source matches. |
| Wrong-agent metadata with summary token | Display name is guarded, but summary still becomes `unguarded`. |
| Foreign summary writer, then mod metadata clears summary | Foreign `foreign-summary` disappears despite mismatched lifecycle guard. Token writes/clears are shared, not source-owned like display-agent metadata. |
| Metadata includes both `display_agent=Johnny5` and `clear_display_agent=true` | Server rejects entire metadata request: `invalid_metadata_request`, `cannot set and clear the same metadata field`. Existing summary/name remains. This happens when cleanup inherits a client/environment display-name fallback. |
| Client response to above rejection | Returns `ok:true` with nested `response.error`; no transport failure. |
| Actual reporter against nonexistent pane | Nested `pane_not_found` error, but snapshot records working/thinking, `lastResultOk:true`, `lastError:null`. Identical retry is deduplicated without another report. |
| Same-source stale/equal sequence | Reports after seq=100 using seq=99 or seq=100 return success but do not change working to blocked. These probes precede native ownership to isolate sequence behavior. |
| Config-only rows | `[ui.sidebar.agents.rows_by_agent] letta = [["state_icon", "workspace", "tab"], ["terminal_title_stripped"]]` loads and reloads with `status:applied`, no diagnostics. |
| Stripped title | Working spinner `⠋ Johnny5` becomes `Johnny5`; approval `[ ! ] Action Required | Johnny5` stays intact. This is not a stable name-only substitute. |

Useful raw labels: `native-then-mod`, `releaseAgent-after-native`, `releaseAgent-after-idle`, `releaseAgent-after-teardown`, `clearAgentAuthority-after-teardown`, `metadata-canonical-display`, `cleanup-both-display-clear`, `reporter-rejected-snapshot`, `foreign-summary`, `unguarded-clear-result`, `native-screen-*`.

## Scope and cleanup

All isolated servers were stopped via their explicit named-session CLI; disposable directories and fixture processes were removed. A process-list check found no surviving research server/fixture. The verified public binary and raw logs remain under `/tmp` for reproduction. Only `runtime-probes.ts` and this findings document are intended repository artifacts; no commit or publication occurred.

Not covered: real paid/provider turns; actual Letta hook ordering during UI bootstrap; real process restart/session replacement; TUI sidebar rendering; statistically concurrent races. Both deterministic RPC orderings were exercised, and native fixture state transitions were observed through the real server API. Treat those as bounded empirical results rather than a complete live Letta end-to-end certification.
