# letta-herdr-mod

A small **metadata-only supplement** to [Herdr](https://herdr.dev/docs/)'s **currently experimental native integration for [Letta Code](https://github.com/letta-ai/letta-code)**. This mod is not a replacement for that integration and does not make its experimental behavior production-certified.

## Limited scope: presentation niceties only

This mod adds just three things:

- **Stable agent name:** show the agent's name (for example, `Johnny5`) rather than only the harness name. Names refresh when supported Letta events arrive; an idle rename may not appear immediately.
- **Optional expiring activity detail:** short labels such as `tool:Read`, displayed while Herdr considers the agent working. Disabled by default; when enabled, labels expire after 30 seconds unless refreshed. They do not determine whether the agent is working, idle or blocked.
- **Read-only diagnostics:** `/herdr-status` shows what the mod intended and what Herdr actually reports, without changing or repairing anything.

Everything else stays with the native integration and Herdr:

| Owner | Responsibility |
| --- | --- |
| Native Letta SessionStart hook | Conversation identity and agent-qualified default sessions |
| Herdr | Restore dispatch, working/idle/blocked state, waits, notifications and completion badges |
| This mod | Display name, optional working label and diagnostics |

The mod never reports semantic state or session identity, releases lifecycle authority, clears authority, installs hooks, handles permissions, or orchestrates panes. There is no legacy lifecycle mode.

Earlier versions duplicated lifecycle reporting. That could conflict with native ownership, leaving stale state or damaging restore identity during repair. The narrower scope avoids competing with Herdr: **native integration first, this companion only for presentation**. If native detection or restore is not working, this mod is not a fallback; troubleshoot the native integration separately.

## Setup

Baseline tested: **Herdr 0.9.1 / Letta Code 0.32.13**, Unix sockets. First enable and verify Herdr's experimental native Letta integration and SessionStart hook using Herdr's documented integration setup, then add this companion in a managed pane. Hook installation is an operator task, not a mod side effect. Native integration contracts may change as the experimental support evolves; the tested baseline is not a promise of compatibility with every version.

Herdr supplies `HERDR_ENV=1`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. Outside Herdr the mod performs no IPC. Letta child agents marked `LETTA_CODE_AGENT_ROLE=subagent` are also disabled so their inherited pane environment cannot overwrite the parent's name. Other independently launched processes sharing a pane are not fenced; run one foreground Letta owner per pane.

For a new installation, after reviewing the code:

```sh
bun install
bun run check
bun run install:local
```

This copies the bundle to `~/.letta/mods/letta-herdr-mod.mjs`. Restart Letta or use `/reload` for an already metadata-only installation. Installation/release is not part of the test gates.

## Migrating from the lifecycle reporter (v0.2.1 and earlier)

This is a breaking behavioral change. **Use a fresh Letta process/pane, not just `/reload`.** Remove/disable the old mod before launching the replacement. A Herdr server restart is not required. The old source's custom lifecycle authority can otherwise remain after a hot upgrade; metadata-only code intentionally does not remove it.

If choosing an in-place migration, an operator must identify and safely release the *old custom* authority, then read back native identity and state. Do not clear native authority/identity. Do not use the old `/herdr-repair`: that command has been removed for safety and is not a migration mechanism. Prefer the fresh-pane path when ownership is uncertain.

Before declaring migration complete, verify native named/default session identity, real working/idle/blocked transitions, agent display name, and owned-metadata cleanup on close/reload. Use `/herdr-status` and `herdr pane get "$HERDR_PANE_ID"`. A successful metadata acknowledgement alone is insufficient.

Version **v0.3.0** introduces this metadata-only scope as a breaking pre-1.0 release. It does not imply that the experimental native integration has reached a stable 1.0 contract.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LETTA_HERDR_DISPLAY_AGENT` | scoped Letta agent name | Nonblank explicit override; otherwise current event/context name. `AGENT_NAME` is not used because it can be stale. |
| `LETTA_HERDR_SOURCE` | `letta-code:mod` | Prefix for two stable, distinct, hashed metadata sources. ASCII letters/digits/`:._-`, 1–80 characters. Keep stable across reloads. |
| `LETTA_HERDR_ACTIVITY_DETAIL` | off | Set exactly `1` to publish only `state_labels.working`. |
| `LETTA_HERDR_ACTIVITY_TTL_MS` | `30000` | Positive integer, 1–86400000 ms. Invalid values use the default; no zero/infinite mode. |

Retired `LETTA_HERDR_AGENT`, `LETTA_HERDR_STATE`, idle/stale/post-tool/watchdog timers and approval-blocked settings are ignored with one setup diagnostic per activation. They cannot re-enable lifecycle writes.

Names are sanitized and limited to 80 Unicode scalar values. `conversation_open` uses its explicit identity/name before scoped context; other supported events refresh names only from matching scoped context. Different agents' `default` contexts are distinct. Observed switches without a name clear the old display name; missing data in the same context can retain it. No title or custom token is written.

Optional activity shows `processing`, `thinking` on local LLM start, `tool:<name>`, or a parallel-tool count. Every activity update refreshes server TTL; name-only observations do not. There is no heartbeat. Tool completion is not background-job completion. Activity clears on observed turn end, model error, context change/close or disposal. Stable names do not expire with activity.

## Diagnostics and limits

`/herdr-status` only reads the calling pane. It reports local expected name, last write acknowledgement, actual read-back display/state/session, activity configuration, capability gaps and last write error. It never refreshes metadata or repairs anything. An ignored guard can still receive a valid acknowledgement; matching text is **not proof of source ownership**. Missing/mismatched native identity is warned about, never corrected.

- Letta does not emit every switch, rename, cancellation or turn-end event. Idle renames/unobserved switches may remain stale until the next supported event. This mod does not fix upstream identity/restore defects.
- Cloud agents do not emit local LLM events. Turn/tool observations still work where their capabilities are available.
- A missed completion leaves only the optional label until its TTL expires. A long-running tool can outlast the TTL. Missing detail **never means work completed**; native semantic state remains authoritative.
- The `agent: letta` guard identifies the harness, not an individual conversation or independent process.
- Same-process reloads use a tiny namespaced `Symbol.for` transport lane keyed by socket/pane/source. Replacement claims the lane; old queued writes/late disposers are ignored, admitted inflight work finishes before replacement clears/writes. Only two fixed server sources are used. This is not cross-process locking.
- Cleanup is best effort on transport failure; native process-exit cleanup provides an additional boundary. No retry daemon, polling or hidden UI is installed.

## Development and verification

```sh
bun run check             # unit tests, typecheck, bundle
bun run test:integration  # separate isolated real Herdr gate
```

The integration gate requires the pinned Linux Herdr 0.9.1 binary (SHA-256 `2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7`) at `/tmp/herdr-v0.9.1-research` and source at `/root/workspace/herdr`, or `HERDR_TEST_BIN` / `HERDR_TEST_SOURCE`. It skips with an explicit reason when absent. It uses temporary HOME/XDG/session directories, an inert compiled `letta` fixture, native hook calls, and cold server restart—no credentials, provider calls or real user sessions. `gcc` is required.

The gate covers both startup orders, native semantic transitions, TTL expiry without state/name mutation, scope changes, rename/override, foreign metadata preservation, ignored guard/error readback, reload cleanup, and native named/default restore command dispatch. Unit tests cover malformed envelopes, bounded IPC, inflight generations and cache-busted module reload. Authenticated resume, every permission/question UI and Windows IPC are not certified.

The separate [production-App fixture](integration/APP_ACCEPTANCE.md) loads the actual built companion in Letta's Ink App with a fake backend and recording socket. It exercises cancellation, new/resume/reload and next-event rename while asserting metadata-only traffic. This is distinct from the real Herdr gate, not authenticated provider acceptance.

Historical [research](docs/research/native-integration/REPORT.md) and its probes describe the **old v0.2.1 baseline**. They are preserved as evidence, not current runnable product gates; some import the now-removed semantic reporter or require an external production App fixture. Use `bun run test`, not unrestricted discovery of archived probes.

## License

MIT. See [LICENSE](LICENSE).
