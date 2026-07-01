# letta-herdr-mod

A Letta Code mod that reports semantic Letta Code state to [Herdr](https://herdr.dev/docs/), the terminal-native agent multiplexer.

The mod is intentionally small:

- reports `working` / `idle` state with short `custom_status` labels to the current Herdr pane;
- releases Herdr lifecycle authority on conversation close or `/reload`;
- includes `/herdr-status` for local diagnostics;
- does not control Herdr panes. Pane orchestration belongs in a separate Herdr skill.

## Build

```bash
bun install
bun test
bun run typecheck
bun run build
```

## Install locally

```bash
cp dist/letta-herdr-mod.mjs ~/.letta/mods/letta-herdr-mod.mjs
```

Then reload Letta Code:

```text
/reload
```

## Verify inside Herdr

The mod only reports when Letta Code is running inside a Herdr-managed pane (`HERDR_ENV=1`).

```bash
echo "$HERDR_ENV"
echo "$HERDR_PANE_ID"
herdr pane get "$HERDR_PANE_ID"
```

In Letta Code:

```text
/herdr-status
```

## Configuration

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LETTA_HERDR_SOURCE` | `letta-code:mod` | Herdr lifecycle source id. |
| `LETTA_HERDR_AGENT` | `letta-code` | Herdr agent label. |
| `LETTA_HERDR_IDLE_DELAY_MS` | `150` | Delay before reporting idle after an LLM/tool event. |
| `LETTA_HERDR_APPROVAL_BLOCKED` | unset | If `1`, report `blocked` during Letta permission overlay approval classification. This is experimental because the current Letta mod API does not expose a dedicated permission-prompt lifecycle event. |

## Current limitation

Letta Code's current mod API does not expose a precise `permission prompt opened` / `permission prompt resolved` event. By default this mod avoids over-reporting `blocked`; during approval waits, Herdr may show `working` until the tool starts or the turn continues.
