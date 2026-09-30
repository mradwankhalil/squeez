# squeez local-fixes: normal install + overlays

squeez is installed **the normal upstream way**. This folder only carries what
upstream does not ship yet (the *overlays*), each tied to an upstream issue, and
a verifier that proves the whole install is healthy.

From `C:/Users/Zephyrus/Documents/ai/squeez-v2-work`:

```text
node local-fixes/verify.mjs            # read-only health check; every line must PASS
node local-fixes/apply.mjs             # dry-run: current health + the promotion plan
node local-fixes/apply.mjs --apply     # promote to the latest release and re-apply overlays
```

Requires Node >= 22, authenticated `gh`, Git Bash, and Python (for the
instruction-block check). squeez compresses shell output, so redirect to a file
and read the file.

## What `apply.mjs --apply` does

1. `squeez update`: upstream's own updater. It downloads the latest release,
   checks it against the release's `checksums.sha256`, swaps the running
   `squeez.exe` by renaming it (Windows allows renaming a running exe, not
   overwriting it), and runs `squeez setup --host=claude-code`.
2. `squeez setup --host=claude-code`, `--host=pi`, `--host=gemini`: the safe
   hosts (`manifest.setupHosts`). They refresh the managed hooks, the buddy and
   the Pi extension from the new binary.
3. Re-applies each overlay **only if it drifted**, with a
   `.bak-squeez-promote-<UTC>` backup next to every changed file.
4. Re-applies the owner config values, only if drifted.
5. Runs the full verification and exits 1 on any FAIL.

It **never** runs bare `squeez setup`, or `setup --host=opencode|codex|copilot`
(`manifest.neverSetupHosts` says why for each).

## Overlays (upstream does not ship these yet)

| Overlay | What | Upstream | Retire when |
|---|---|---|---|
| `opencode-plugin` | Owner OpenCode plugin: Windows `-EncodedCommand` wrapping; bounded WSL timeout (`taskkill /F /T`, exit 124) | squeez #244, #239; #242 for OpenCode 2.x | a release's plugin has both, checked by marker |
| `copilot-hooks` | Copilot hooks under `hooks.<Event>` with forward-slash paths | squeez #243 | setup writes them there itself |
| `codex-hooks-off` | No squeez hook in Codex; context-mode Codex plugin disabled (owner decision X-74/X-119) | openai/codex#49164 | a stable Codex with #49164 **and** an owner decision |

Owner config (not patches): `wrap_timeout_secs = 540`, `context_window_tokens =
1000000`, and `auto_compress_md = false` in all six host configs plus the
OpenCode v2 profile's (`~/.opencode-v2/config/opencode/squeez/config.ini`)
(`manifest.configWhy`).

**A missing config.ini is not neutral.** `squeez init` falls back to its defaults
when the file is absent, and the default is `auto_compress_md = true`, which
rewrites `~/.claude/CLAUDE.md` on every session start. `manifest.configRequiredWhen`
maps a config file to the plugin or hook that runs `init` for that host: while
that trigger exists, an absent file is a FAIL and `apply.mjs --apply` creates it.

## What `verify.mjs` checks (26 checks on 2026-09-30)

Binary is CONSOLE (PE subsystem 3) and its SHA-256 equals the official release
checksum; `squeez doctor` has no `[FAIL]`; the Pi extension and 6 buddy files
equal the installed tag's templates; each overlay is in place (the plugin is
byte-identical, has its markers, and passes its 9 tests); every config value
holds, and every required config file exists; and the four canonical instruction
blocks are IN SYNC.

## Adding an overlay

Only when upstream is missing something and an issue or PR exists for it:
file it first, then add an entry to `manifest.overlays` with `id`, `what`,
`target`, `upstream[]` (URL + state) and `retireWhen`, implement its check in
`verificationChecks` and its repair in `reapplyOverlay` (`pipeline.mjs`), and
add a fixture test. The manifest test refuses an overlay without an upstream
URL or a retire condition.

## Retiring an overlay

When its upstream fix ships in a release, run `apply.mjs --apply`, confirm the
overlay's check passes with nothing re-applied, then delete the entry, its
check, and its repair in one commit.

## Git: branch `local/fixes-ledger`

Committed on `local/fixes-ledger` of `github.com/mradwankhalil/squeez` (remote
`fork`). The working copy stays untracked in the `feat/opencode-v2-dual-export`
checkout. **Never `git checkout local/fixes-ledger` here**: switching back would
delete this folder. Snapshot through a temporary worktree:

```text
W=$TEMP/sq-ledger && git worktree add "$W" local/fixes-ledger
rm -rf "$W/local-fixes" && cp -r local-fixes "$W/local-fixes"
git -C "$W" add -A local-fixes && git -C "$W" commit -m "ledger: <what changed>"
git -C "$W" push fork local/fixes-ledger && git worktree remove "$W"
```

Tests: `node --test local-fixes/pipeline.test.mjs`. Contract: `CONTRACT.md`.
Skill: `mk-squeez-promote`.
