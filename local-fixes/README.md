# squeez local-fixes promote

**No owner fix lives in the binary.** The live `squeez.exe` is the stock upstream
Windows x64 asset: PE subsystem 3 (CONSOLE), byte-identical to the official
release digest recorded in `installed.json`. No Rust build, cargo, PE patching,
`squeez setup` or `squeez update`.

From `C:/Users/Zephyrus/Documents/ai/squeez-v2-work`:

```text
node local-fixes/verify.mjs                                # health; every line must PASS
node local-fixes/apply.mjs --dry-run [--version vX.Y.Z]    # plan only
node local-fixes/apply.mjs --apply --version vX.Y.Z        # stage official binary, reinstall owner plugin
git fetch origin tag vX.Y.Z --no-tags                      # activate reads asset templates from the tag
node local-fixes/activate.mjs --dry-run --version vX.Y.Z   # plan only
node local-fixes/activate.mjs --apply --version vX.Y.Z     # swap binary, refresh assets, record, verify
```

No mode flag means dry-run. Only plain `vX.Y.Z` release tags are accepted (no
prereleases, bare versions, branches or URLs). `apply` without `--version`
resolves GitHub's latest stable release; `activate` requires `--version`. Each
run has an 18-second budget and external commands get the remainder. Requires
Node >= 22, authenticated `gh` and Windows `curl.exe`. squeez compresses shell
output, so redirect to a file and read the file.

## What each entrypoint does

- **apply** resolves release metadata through `gh`. Dry-run prints the plan and
  returns before any check, download or write. `--apply` runs the protected
  invariants (abort on the first drift), downloads the asset into memory,
  requires its size, the published SHA-256 and subsystem 3, writes
  `staged/squeez-vX.Y.Z.exe` (gitignored), reinstalls the owner plugin
  byte-for-byte and runs its 9 tests (restoring the previous plugin on failure),
  then runs the invariants again. It never touches the live binary.
- **activate** requires the staged file and the tag in this repository, requires
  the staged bytes to equal the official digest and to be CONSOLE, and reads
  every release-asset template before changing anything. `--apply` then runs the
  invariants, moves the live `squeez.exe` aside as
  `squeez.exe.bak-squeez-activate-<UTC>` and writes the staged bytes in its
  place. Windows refuses to overwrite a running executable but allows renaming
  it (measured 2026-09-30), so no retry loop is needed; if the write fails the
  original is renamed back. It refreshes every `policy.releaseAssets` target from
  `git show <tag>:<template>` keeping the file's line-ending style, writes
  `installed.json`, and runs full verification, failing with backup paths if
  anything is red. A live binary that already equals the staged bytes is left
  alone.
- **verify** is read-only. It prints every result, then `N pass / M fail`, and
  exits 1 on any failure.

## What verify checks (29 checks on 2026-09-30)

| Check | Why |
|---|---|
| Binary exists, PE subsystem 3, SHA-256 equals `installed.json` | Official console build (X-17/X-19) |
| Pi extension and 6 buddy lib files equal `<installed tag>:<template>` | #235 Pi `windowsHide` and #240 buddy sizing live in these files, not the binary |
| Owner plugin byte-identical; markers `windowsHide: true`, `taskkill /F /T /PID`, `-EncodedCommand`, `export default {` | Hidden windows, #239 WSL supervisor, PowerShell-safe wrapping |
| Installed plugin tests: 9 pass, 0 fail, 0 skip | Behavioural spec of the plugin helpers |
| One owner PostCompact, no managed `postcompact.sh`; compact-restore bytes and SessionStart reference | Single quiet delivery path with owner caps |
| Codex, per `policy.codex.hooksMode`: `off` = no squeez command in `hooks.json` and context-mode plugin `enabled = false`; `owner` = exactly three commands pointing at the user-hook scripts | Owner decision X-74 / X-119 (currently `off`) |
| Codex user-hook scripts byte-identical to `codex-user-hooks/` | Kept ready for the day Codex hooks return |
| `wrap_timeout_secs = 540` and `context_window_tokens = 1000000`, single active key, `~/.claude/squeez/config.ini` | Owner config; #219 pin |
| `auto_compress_md` off in all six host configs | `init --host=<h>` reads `<host>/squeez/config.ini` (X-98, X-119); squeez treats only the exact value `true` as on |

Protected files are **check-only**: `settings.json`, Codex `hooks.json` and
`config.toml`, every `config.ini`, and the owner and Codex user-hook scripts.
Drift aborts `apply` and `activate` before anything is written. Repairing
drift needs an explicit owner decision; the pipeline never repairs it.

## Fix set

`manifest.json` is the ledger (15 entries); `policy.json` holds the protected
expectations and the release-asset list.

| Fix id | Lives in | Upstream status |
|---|---|---|
| `windows-hide` | owner plugin | #235 shipped 1.48.6; owner plugin still preserved because setup replaces it |
| `wsl-supervisor` | owner plugin | #239 OPEN; carried |
| `powershell-encoded-wrap` | owner plugin | owner-only |
| `plugin-source` | owner plugin | #242 OPEN (OpenCode 2.x dual export; not installed) |
| `compact-restore` | owner hook | #232/#233 shipped; owner caps 8,000 chars / 2 MB kept |
| `postcompact-quiet` | owner hook | #236 shipped; ownership still verified |
| `codex-hooks-off` | Codex registration | owner decision until a stable Codex >= 0.160 ships openai/codex#49164 |
| `codex-user-session-start`, `-pretooluse`, `-posttooluse` | Codex user hooks | owner copies |
| `wrap-timeout` | `~/.claude/squeez/config.ini` | owner 540 s |
| `context-window-pin` | `~/.claude/squeez/config.ini` | owner #219 pin |
| `auto-compress-md` | six host configs | X-28 / X-98 / X-119 |
| `release-assets` | Pi extension + buddy lib | #235 Pi, #240 buddy |
| `console-subsystem` | binary | never GUI-patch (X-17, X-19) |

## Git: branch `local/fixes-ledger`

This folder is committed on `local/fixes-ledger` of
`github.com/mradwankhalil/squeez` (remote `fork`), branched from `main` at
v1.48.10. The working copy here stays untracked on whatever branch this checkout
has out (normally `feat/opencode-v2-dual-export`).

**Never `git checkout local/fixes-ledger` in this checkout.** Switching back to
any branch that does not track `local-fixes/` would delete this folder from
disk. Snapshot through a temporary worktree instead:

```text
W=$TEMP/sq-ledger && git worktree add "$W" local/fixes-ledger
cp -r local-fixes/. "$W/local-fixes/"        # staged/ stays ignored
git -C "$W" add local-fixes && git -C "$W" commit -m "ledger: <what changed>"
git -C "$W" push fork local/fixes-ledger && git worktree remove "$W"
```

## Rollback

Every overwritten file gets an adjacent backup first: `.bak-squeez-promote-<UTC>`
for the plugin, staged file and release assets, `.bak-squeez-activate-<UTC>` for
the binary. Identical files are not rewritten. There is no transaction across
files: a late failure keeps the backups and stops. Restore a binary by renaming
the backup back (rename works while the current one runs). Verify the PE
subsystem of any backup before using it; its name is not proof. Never delete
backups automatically.

Tests: `node --test local-fixes/pipeline.test.mjs` (temporary fixtures only).
Contract: `CONTRACT.md`. Companion skill: `mk-squeez-promote`.
