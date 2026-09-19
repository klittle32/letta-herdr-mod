# Production Letta App acceptance

`fixtures/letta-app-probe.tsx` loads the actual built companion mod alongside a recording observer into Letta Code's production Ink `App`. It uses the upstream fake backend and a recording Unix socket server, not a provider or an authenticated conversation.

Run separately from ordinary unit tests because its imports belong to the pinned Letta source tree:

```sh
# From this mod repository:
bun run build
MOD_ROOT="$PWD"

git clone --depth 1 --branch v0.32.13 \
  https://github.com/letta-ai/letta-code.git /tmp/letta-app-acceptance
cd /tmp/letta-app-acceptance
bun install --frozen-lockfile --ignore-scripts
cp "$MOD_ROOT/integration/fixtures/letta-app-probe.tsx" src/cli/herdr-companion.test.tsx
env -i PATH="$PATH" HOME=/tmp LETTA_CODE_TELEM=0 \
  COMPANION_BUNDLE="$MOD_ROOT/dist/letta-herdr-mod.mjs" \
  PROBE_RESULTS=/tmp/herdr-companion-app-results.json \
  bun test src/cli/herdr-companion.test.tsx
```

The upstream test preload supplies and cleans a disposable HOME. The fixture intercepts ancillary `fetch` calls before transport; inference uses only `FakeHeadlessBackend`. It discovers the real mod through that temporary home's mod directory and exercises normal completion, ESC cancellation, `/new`, successful direct `/resume`, `/reload`, rename and the following turn.

Assertions verify only presentation RPCs, canonical agent guard, no source-authority guard or global tokens, exactly two stable sources, bounded activity TTL, and the renamed display value. Historical missing-event behavior is explicitly retained in assertions; this mod does not fix upstream SessionStart or cancellation semantics.

Initial execution with the metadata-only implementation passed **1 test / 18 assertions** on Linux, Bun 1.3.14, Letta source `6db64e8f533e9c13d81536410460b83ef06e3bc4`. Rerun after product changes; this is not a substitute for the independent actual-Herdr gate (`bun run test:integration`).

This fixture does not establish native TTL expiry, real sidebar rendering, authenticated restore, provider errors or full permission/question UI coverage. Those require different evidence. Do not use its socket acknowledgements to claim real Herdr application of metadata.
