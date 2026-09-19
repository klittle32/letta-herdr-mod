# Metadata-only implementation evidence

2026-09-19, Linux sandbox; original worktree branch `letta/native-integration-investigation-7236758f`, baseline `339e655`.

## Shipped source changes (not yet committed or installed)

- Presentation-only client: canonical Letta guard, two stable metadata sources, explicit source-scoped clears; only pane reads and metadata writes.
- Activation-owned metadata reporter: names, optional server-expiring working detail, parallel tool tracking, generation fencing and same-process reload-safe transport lane.
- Removed semantic reporter, session/authority write APIs, permission observer and repair command.
- Read-only diagnostics; native session identification validates source, canonical agent and ID kind.
- Subagent environments disabled to avoid inherited pane writes.
- Documented breaking migration, retired settings and known upstream event limitations. Package version deliberately unchanged pending release authorization.

## Executed gates

| Gate | Final result |
|---|---|
| `bun run check` | 25 unit tests, 98 assertions; typecheck and build passed |
| `HERDR_TEST_BIN=/tmp/herdr-v0.9.1-research HERDR_TEST_SOURCE=/root/workspace/herdr bun run test:integration` | 1 real-Herdr test, 60 assertions, passed in 11.89 seconds |
| Production-App companion fixture, pinned Letta 0.32.13 | 1 test, 18 assertions; final bundle passed in 10.67 seconds |
| `git diff --check` | Passed |
| Production source scan for lifecycle/session/authority endpoints and permission/repair registration | No matches |

Herdr binary verified SHA-256 `2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7`; both test client and server 0.9.1. Native sources pinned at `065ef9d`. Letta App source pinned at `6db64e8f533e9c13d81536410460b83ef06e3bc4`. Bun 1.3.14.

Real Herdr tests used only created temporary HOME/XDG directories and inert fixture processes; they verified both startup orders, native working/blocked/completion transitions, activity expiry preserving name/state, unrelated metadata preservation, cleanup/reload, and cold restart dispatch for a named conversation plus two distinct default agents. Test servers were stopped and removed.

The production App fixture loads the actual mod with fake inference and a recording Unix socket, intercepts ancillary fetches, and uses no provider credentials. It covers the known cancellation/new/resume/reload/rename paths without claiming upstream missing events were repaired. Reproduction: [integration/APP_ACCEPTANCE.md](../integration/APP_ACCEPTANCE.md).

## Review correction

Independent review found an Alice → queued/inflight Bob → Alice name-deduplication race. Two new regression tests failed first. Revision-aware pending-name tracking fixed it; queued and inflight variants now pass. A native-session-kind diagnostic regression also failed before correction. Final focused independent review found no remaining blockers.

Formatting used transient Prettier tooling; no package dependency or lockfile change was introduced for it.

## Boundaries

Not installed, committed, pushed, tagged or published. No user session changed. Authenticated restore/provider behavior, complete approval/question UI, Windows IPC and independent processes concurrently writing one pane remain uncertified. Known idle rename/switch gaps remain documented. A fresh Letta process/pane is the recommended migration from the old lifecycle mod.
