# Cold restart dispatch: isolated Herdr 0.9.1

**Result: passed, fixture-backed.** This tests actual persisted-session cold restart and executable argv, not authenticated Letta resume or provider behavior.

Run `bun docs/research/native-integration/runtime-restore-probes.ts`. Requirements are the verified `/tmp/herdr-v0.9.1-research` binary, gcc, Bun, and pinned native shell hook at `/root/workspace/herdr`. Raw records: `/tmp/herdr-issue4-restore-results.json`. Core runtime harness/results are unchanged.

## Method

On 2026-09-18, Linux x86_64, Bun 1.3.14, Herdr 0.9.1/protocol 22:

1. Created disposable HOME/XDG directories and explicit config with manifest updates disabled and `session.resume_agents_on_restore = true`.
2. Started only a new named `issue4-restore` server.
3. Compiled a no-argument C fixture named `letta`; it logs its argv and inherited pane ID to a temporary file. Prepended its directory to the scrubbed environment's PATH, ensuring restore invokes this fixture, never installed authenticated Letta.
4. Created three panes and launched the fixture. Invoked the real native SessionStart shell helper with one named conversation and two distinct default-agent identities.
5. Verified persisted session refs, stopped that server through its explicit named-session CLI, then started a new server using the same isolated session directory.
6. Read new fixture launch records and restored pane identities, then stopped the created server and removed temporary files.

## Captured results

| Pane | Session before stop | Executable argv after cold restart |
| --- | --- | --- |
| `w1:p1` | `conv-research` | `letta --conversation conv-research` |
| `w1:p2` | `default:agent-A` | `letta --conversation default --agent agent-A` |
| `w1:p3` | `default:agent-B` | `letta --conversation default --agent agent-B` |

All three restored panes retained their own native session reference. Each fixture launched once after restart; both default sessions launched independently, without a deduplication collision. New terminal IDs after restart independently corroborated new terminal processes rather than attachment to the old server.

Exact post-restart launch-log additions:

```text
pane=w1:p2 | letta | --conversation | default | --agent | agent-A
pane=w1:p1 | letta | --conversation | conv-research
pane=w1:p3 | letta | --conversation | default | --agent | agent-B
```

The initial server PID was 6009 and temporary root `/tmp/herdr-restore-NNqLrZ`; this root was removed. Both explicit server-stop commands exited 0. No provider credentials were inherited, no paid turns occurred, and no existing server/config was changed. The earlier same-process session-switch limitation is distinct: this probe confirms correct dispatch for identities already captured in separate panes and persisted across a genuine server restart.
