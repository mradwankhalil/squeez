# Promote contract

- **Names:** `node local-fixes/apply.mjs [--dry-run | --apply]`, `node local-fixes/verify.mjs`; both share `pipeline.mjs`.
- **Purpose:** promote squeez with upstream's own installer and keep the owner overlays and config in place. The pipeline never builds, patches or downloads the binary itself.
- **Install path:** `squeez update` (latest release only; checksum-verified by squeez), then `squeez setup --host=<h>` for `manifest.setupHosts` only. Bare `squeez setup` and the `neverSetupHosts` are never run.
- **Inputs:** no flag = dry-run; `--apply` once. Unknown or duplicate flags fail. `verify` takes none.
- **Writes (apply only):** whatever `squeez update`/`setup` write; each drifted overlay target and drifted config file, after a `.bak-squeez-promote-<UTC>` copy (Codex `hooks.json` is renamed to that name instead); and each `manifest.configRequiredWhen` config file that is absent while its trigger exists (created with the manifest keys; nothing to back up). Unchanged files are not rewritten.
- **Outputs:** `PASS`/`FAIL`/`SKIP`/`INFO` lines and `N pass / M fail`; exit 0 or 1. File contents, child output details and secrets are not printed.
- **Failure model:** `squeez update` failing or queuing the swap stops before anything else. A plugin re-apply that fails its tests restores the previous plugin. Any later failure stops with backups in place. There is no transaction across files.
- **Tests:** `node --test local-fixes/pipeline.test.mjs`: 13 tests on fixtures, temp directories and the real manifest; they never touch live files.
- **Proof (2026-09-30):** four surfaces were broken the way a bare `squeez setup` breaks them (upstream plugin, top-level Copilot registration, Codex `hooks.json`, `auto_compress_md = true`). `verify` reported 7 FAIL; one `apply --apply` repaired all of it; `verify` returned 25 pass / 0 fail.
- **Proof (2026-09-30, later):** with `configRequiredWhen` added, `verify` reported 25 pass / 1 fail (the OpenCode v2 profile's `config.ini` was absent while its squeez plugin existed, so squeez would have run with `auto_compress_md = true`); after the file was created, 26 pass / 0 fail.
