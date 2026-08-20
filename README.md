# letta-herdr-mod

A small [Letta Code](https://github.com/letta-ai/letta-code) mod that reports the current agent state to [Herdr](https://herdr.dev/docs/), the terminal-native agent multiplexer.

The mod is intentionally narrow: it reports state for the current Herdr pane, exposes a local diagnostics command, and releases its Herdr lifecycle authority when Letta Code closes the conversation or reloads mods. It does **not** create panes, move panes, or otherwise orchestrate Herdr; pane orchestration belongs in a separate Herdr skill or workflow.

## What it reports

The primary lifecycle mapping follows Herdr's built-in harness integrations:

| Letta event | Herdr state | Display metadata | Notes |
| --- | --- | --- | --- |
| `conversation_open` | `idle` | `ready` | Initializes pane state. |
| `turn_start` | `working` | `turn` | Start of an agent turn. |
| `llm_start` | `working` | `thinking` | Model is processing. |
| `tool_start` | `working` | `tool:<name>` | Tool events are status detail within a turn. |
| `tool_end` | `working` | `thinking` | Avoids flickering to idle between tool calls. |
| `turn_end` | `idle` | `ready` | Debounced by `LETTA_HERDR_IDLE_DELAY_MS`. |
| `conversation_close` / `/reload` | release | n/a | Releases this mod's lifecycle authority for the pane. |

`turn_start` -> `working` and `turn_end` -> `idle` are the durable lifecycle boundaries. Tool events are deliberately not treated as completion signals by default.

For Herdr 0.8.2 and newer, lifecycle reports are semantic state only. The mod sends labels such as `thinking` and `tool:<name>` through `pane.report_metadata` as display-only metadata (`summary` token plus a state label) instead of the old `custom_status` field on `pane.report_agent`.

Blocked states include short Herdr messages where Letta exposes enough context, such as `Approval required` or a bounded LLM error message.

## Requirements

- Letta Code with local mods enabled.
- Herdr running Letta Code in a Herdr-managed pane.
- [Bun](https://bun.sh/) for local development/builds.

Herdr normally injects the environment variables this mod needs (`HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`) into managed panes. Outside a Herdr pane, the mod stays disabled and `/herdr-status` explains why.

## Install from source

```bash
git clone https://github.com/klittle32/letta-herdr-mod.git
cd letta-herdr-mod
bun install
bun run install:local
```

`bun run install:local` builds the bundled mod and copies it to:

```text
~/.letta/mods/letta-herdr-mod.mjs
```

Then reload Letta Code:

```text
/reload
```

If you prefer to run the steps manually:

```bash
bun run build
mkdir -p ~/.letta/mods
cp dist/letta-herdr-mod.mjs ~/.letta/mods/letta-herdr-mod.mjs
```

## Update an existing install

From the source checkout:

```bash
git pull
bun install
bun run install:local
```

Then run `/reload` in Letta Code.

## Verify inside Herdr

In the shell where Letta Code is running:

```bash
echo "$HERDR_ENV"
echo "$HERDR_PANE_ID"
herdr pane get "$HERDR_PANE_ID"
```

In Letta Code:

```text
/herdr-status
```

If Herdr shows stale state for this mod after a crash or interrupted reload, clear this mod's lifecycle authority and display metadata without touching other Herdr sources:

```text
/herdr-repair
```

Expected healthy output includes:

```text
letta-herdr-mod: enabled
pane: ...
socket: ...
last result: ok
```

If it says `disabled`, check that Letta Code was launched from a Herdr-managed pane and that `HERDR_SOCKET_PATH` / `HERDR_PANE_ID` are present.

## Configuration

Set optional environment variables wherever you launch Letta Code/Herdr.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LETTA_HERDR_SOURCE` | `letta-code:mod` | Herdr lifecycle source id used when reporting/releasing state. Must match `[A-Za-z0-9:._-]` and be at most 80 characters. |
| `LETTA_HERDR_AGENT` | `letta-code` | Herdr agent label shown for this reporter. |
| `LETTA_HERDR_DISPLAY_AGENT` | `$AGENT_NAME` | Optional display-only Herdr agent name. Defaults to Letta Code's agent name when available, leaving lifecycle authority as `LETTA_HERDR_AGENT`. |
| `LETTA_HERDR_IDLE_DELAY_MS` | `250` | Debounce before reporting idle after Letta's `turn_end` or a final LLM completion event. Must be a positive integer. |
| `LETTA_HERDR_STALE_WORKING_MS` | `300000` | Conservative safety fallback before reporting idle after a turn/LLM working event if no `turn_end` or completion event arrives. Set `0` to disable. |
| `LETTA_HERDR_POST_TOOL_IDLE_MS` | `0` | Opt-in fallback before reporting idle after a tool completes and no next tool/turn-end event arrives. Disabled by default because `turn_end` is the primary completion signal. |
| `LETTA_HERDR_TOOL_WATCHDOG_MS` | `0` | Opt-in watchdog before reporting idle after a tool starts if no `tool_end` or `turn_end` event arrives. Disabled by default; use only for hosts without reliable turn completion. |
| `LETTA_HERDR_APPROVAL_BLOCKED` | unset | If `1`, `true`, or `yes`, report `blocked · approval` during Letta permission overlay approval classification. Experimental; see limitations below. |

Example:

```bash
export LETTA_HERDR_IDLE_DELAY_MS=250
export LETTA_HERDR_STALE_WORKING_MS=300000
```

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

Or run the full local check:

```bash
bun run check
```

## Limitations

- Letta Code's current mod API does not expose a precise `permission prompt opened` / `permission prompt resolved` event. By default this mod avoids over-reporting `blocked`; during approval waits, Herdr may show `working` until the tool starts, the approval resolves, or the turn continues.
- `turn_start` and `turn_end` registration requires the host to expose `letta.capabilities.events.turns`. Modern Letta Code builds do; older or unusual hosts may fall back to LLM/tool events plus the stale-working safety timer.
- `turn_end` is the preferred completion signal. The stale-working fallback is intentionally conservative so ordinary long-running model turns do not flicker to idle.
- Tool watchdog behavior is opt-in. Long-running tools are common, so a watchdog is risky as a default lifecycle boundary.
