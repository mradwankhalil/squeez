#!/usr/bin/env bash
# squeez PostCompact hook — quiet replacement. USER-OWNED.
#
# WHY THIS EXISTS
#   squeez's own hooks/postcompact.sh ends with `squeez compact-summary`, which
#   prints {"hookSpecificOutput":{"hookEventName":"PostCompact",...}}.
#   `PostCompact` is not in Claude Code's hookSpecificOutput whitelist
#   (PreToolUse | PermissionRequest | UserPromptSubmit | UserPromptExpansion |
#   SessionStart | Setup | PreModelSwitch), so every single /compact prints a
#   large red "Hook JSON output validation failed" block to the user.
#
#   Emitting valid JSON would not help either: the PostCompact executor reads
#   only raw stdout to build a UI toast and never feeds structured output back
#   to the model. PostCompact cannot inject context at all on current builds.
#
#   The actual post-compaction state restore happens at SessionStart with
#   source == "compact", handled by hooks/squeez-compact-restore.sh.
#   So here we keep the telemetry and emit NOTHING.
#
#   This file is registered directly in ~/.claude/settings.json in place of
#   squeez's script, so `squeez setup` and `squeez update` cannot revert it and
#   `squeez doctor` stays green (squeez's own files are left pristine).
#
#   See 15-INCIDENT-AND-WORKAROUND-LEDGER.md X-07 and upstream issue #225.
set -uo pipefail

SQUEEZ="$HOME/.claude/squeez/bin/squeez"
if [ ! -x "$SQUEEZ" ]; then
    _sq=$(command -v squeez 2>/dev/null || true)
    [ -n "$_sq" ] && SQUEEZ="$_sq"
fi
[ ! -x "$SQUEEZ" ] && exit 0

# Telemetry only. Never write to stdout: anything printed here is either
# rejected by the schema or shown to the user as a toast.
"$SQUEEZ" track PostCompact 0 >/dev/null 2>&1 || true

exit 0
