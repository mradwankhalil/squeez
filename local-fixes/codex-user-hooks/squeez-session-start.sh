#!/usr/bin/env bash
# User-Owned Squeez SessionStart Hook (Quiet / Update-Proof)
set -euo pipefail

SQUEEZ_PY=""
for _c in python3 python py; do
    if command -v "$_c" >/dev/null 2>&1 && "$_c" -c "" >/dev/null 2>&1; then
        SQUEEZ_PY="$_c"
        break
    fi
done
[ -z "$SQUEEZ_PY" ] && exit 0

SQUEEZ="$HOME/.claude/squeez/bin/squeez"
if [ ! -x "$SQUEEZ" ]; then
    _sq=$(command -v squeez 2>/dev/null || true)
    [ -n "$_sq" ] && SQUEEZ="$_sq"
fi
[ ! -x "$SQUEEZ" ] && exit 0

export SQUEEZ_DIR="$HOME/.codex/squeez"

# Finalize previous session and refresh ~/.codex/AGENTS.md quietly
"$SQUEEZ" init --host=codex >/dev/null 2>&1 || true

# Emit clean SessionStart payload without additionalContext to keep TUI silent
"$SQUEEZ_PY" -c '
import json
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart"
    }
}))
'
