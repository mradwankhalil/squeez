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
5. Writes the OMO exclusion (below), only when no running OpenCode server
   predates the installed plugin; otherwise prints `DEFER` and changes nothing.
6. Runs the full verification and exits 1 on any FAIL.

It **never** runs bare `squeez setup`, or `setup --host=opencode|codex|copilot`
(`manifest.neverSetupHosts` says why for each).

## Overlays (upstream does not ship these yet)

| Overlay | What | Upstream | Retire when |
|---|---|---|---|
| `opencode-plugin` | Owner OpenCode plugin: the wrapper follows the OpenCode `shell` key, not the OS (PowerShell: `-EncodedCommand`; bash: POSIX quoting, forward-slash quoted binary); bounded WSL timeout under PowerShell (`taskkill /F /T`, exit 124), WSL left unwrapped under bash; no synchronous child processes (the first `execSync` of a hook call fails with a false `ETIMEDOUT` inside the server) | squeez #244, #239, #245 (PR #246); #242 for OpenCode 2.x | a release's plugin has both, checked by marker |
| `copilot-hooks` | Copilot hooks under `hooks.<Event>` with forward-slash paths | squeez #243 | setup writes them there itself |
| `codex-hooks-off` | No squeez hook in Codex; context-mode Codex plugin disabled (owner decision X-74/X-119) | openai/codex#49164 | a stable Codex with #49164 **and** an owner decision |
| `buddy-english` | English translation of the buddy: 11 scripts under `~/.claude/squeez/buddy` and `~/.claude/commands/buddy.md` (source `buddy-english/`). Upstream ships them in Portuguese, including the block the session-start hook injects into every Claude Code session; `squeez update` and `setup --host=claude-code` restore the Portuguese templates | not filed yet: issue + PR drafted in `Documents/ai/storage/buddy-english-20261013/upstream/` (`manifest` key `upstreamPending`) | a release's `assets/buddy` templates are English (or follow `lang`); check `hooks/session-start.js` at the tag |

Owner config (not patches): `wrap_timeout_secs = 540`, `context_window_tokens =
1000000`, and `auto_compress_md = false` in all six host configs plus the
OpenCode v2 profile's (`~/.opencode-v2/config/opencode/squeez/config.ini`)
(`manifest.configWhy`).

**A missing config.ini is not neutral.** `squeez init` falls back to its defaults
when the file is absent, and the default is `auto_compress_md = true`, which
rewrites `~/.claude/CLAUDE.md` on every session start. `manifest.configRequiredWhen`
maps a config file to the plugin or hook that runs `init` for that host: while
that trigger exists, an absent file is a FAIL and `apply.mjs --apply` creates it.

## OMO exclusion (`manifest.omoClaudeHooksOff`)

oh-my-openagent runs Claude Code's PreToolUse hooks on OpenCode tool calls and
applies their `updatedInput` with `output.args = {...}`. OpenCode executes the
original args object, so that result is dropped, and the squeez plugin, which
runs after OMO, edits the detached copy. Result before 2026-10-02: only commands
that `squeez should-wrap` rejects (`rm -rf`, `git push --force`) reached the
plugin's wrapper; everything else ran raw. `~/.config/opencode/opencode-cc-plugin.json`
now excludes squeez's Claude `pretooluse.sh` for OMO, so the plugin is the only
wrapper under OpenCode and its edit lands on the object OpenCode executes.

**Restart order matters.** A server that started before the plugin file was
written still runs the previous plugin. `apply.mjs` therefore writes the
exclusion only when no `opencode*` process predates the plugin; until then
verify reports `SKIP ... pending OpenCode restart`. Restart OpenCode, rerun
`apply.mjs --apply`; OMO re-reads the file within 30 seconds.

**The other half lives in the OMO ledger.** OMO's `non-interactive-env` hook
rewrote every command containing the word `git` through the same `replaceToolArgs`,
so those stayed detached. OMO ledger fix `17-tool-args-in-place`
(`Documents/ai/oh-my-openagent-fix/local-fixes`, 2026-10-02) makes OMO edit the
args in place. With that fix the Claude hook's own rewrite would take effect too;
it only knows the POSIX form and also compresses Task prompts, so the exclusion
stays: the shell-aware plugin is the one wrapper under OpenCode.

## What `verify.mjs` checks (31 checks on 2026-10-13)

Binary is CONSOLE (PE subsystem 3) and its SHA-256 equals the official release
checksum (`SKIP` while a binary fix is `live`: then the binary must carry each fix's
markers and be byte-for-byte the artifact recorded in `binaryFixes[].staged`); `squeez doctor` has no `[FAIL]`; the Pi extension equals the installed
tag's template; the 12 buddy files equal the ledger's English translation (line
endings aside) and their templates at the installed tag are still the ones the
translation was made from; each overlay is in place (the plugin is
byte-identical, has its markers, and passes its 18 tests, and the installed test file is byte-identical to the ledger copy `opencode-plugin/squeez-plugin.test.mjs`); every config value
holds, and every required config file exists; the OMO exclusion is present (SKIP
while an OpenCode restart is pending); and the four canonical instruction blocks
are IN SYNC.

## Binary fixes are live (2026-10-12)

Both `manifest.binaryFixes` entries are `live`: the installed binary is the reviewed
build of `4f89287` (SHA-256 `8eb9be74…c300`, 2,390,528 B). Activation record and
rollback: `Documents/ai/storage/squeez-window-live-20261012/WINDOW-LOG.md`. While they
are live, `apply.mjs --apply` stops before `squeez update`.

`STATE_OUTSIDE_WATCHED_CONFIG_V1` is a **binary** marker. The owner plugin never
carried it; the v2 overlay listed it by mistake until the review gate removed it
(commit `2ba138e`). This working copy missed that commit until 2026-10-13, which is
why verify failed that marker here: the check was stale, not the plugin.

**The working copy can fall behind the branch.** `2ba138e` was committed from another
worktree (`storage/squeez-review-gate-20261011T214733Z/ledger`) and never copied back.
Before a snapshot, compare first: `git diff --stat local/fixes-ledger -- local-fixes`
must show only your own changes. If the branch has commits this folder lacks, merge
them in; a blind `rm -rf` + `cp -r` snapshot would revert them.

## Adding an overlay

Only when upstream is missing something and an issue or PR exists for it:
file it first, then add an entry to `manifest.overlays` with `id`, `what`,
`target`, `upstream[]` (URL + state) and `retireWhen`, implement its check in
`verificationChecks` and its repair in `reapplyOverlay` (`pipeline.mjs`), and
add a fixture test. The manifest test refuses an overlay without an upstream
URL or a retire condition. The one exception to "file it first": an overlay whose
issue is drafted and waits for the owner's upstream batch carries `upstream: []`
and `upstreamPending` (where the draft is), like a binary fix; replace it with
the URLs once filed.

### `buddy-english`: a translation is tied to the template it was made from

`squeez update` and `squeez setup --host=claude-code` rewrite every buddy file
from the templates embedded in the binary, so after each promotion the 12 files
are Portuguese again and step 3 puts the translation back (backup of each file
first). Each `files[]` entry records `baseSha256`, the SHA-256 of the template
(LF line endings) the translation was made from, at `base`. When a release
changes one of those templates, re-applying would silently undo upstream's
change: `apply.mjs` then prints `DEFER buddy-english`, writes none of the 12
files, and verify FAILs the "templates are the base" check. To fix: redo the
translation on the new templates (the spec of the first one is
`Documents/ai/storage/buddy-english-20261013/spec.json`), copy the result into
`buddy-english/`, update `base` and each `baseSha256`, rerun `apply.mjs --apply`.
The six `assets/buddy/lib` files left `releaseAssets` when this overlay was
added; they go back when it retires.

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
