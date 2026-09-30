#!/usr/bin/env bash
# User-Owned Squeez PreToolUse Hook (Update-Proof)
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

SQUEEZ_BIN="$SQUEEZ" "$SQUEEZ_PY" -c "
import json, os, shlex, subprocess, sys

data = sys.stdin.read()
if not data.strip():
    sys.exit(0)
try:
    d = json.loads(data)
except json.JSONDecodeError:
    sys.exit(0)

tool = d.get('tool_name') or d.get('tool') or ''
if tool not in ('bash', 'Bash', 'shell', 'Shell', 'run_shell_command',
                'exec_command', 'local_shell', 'shell_command'):
    sys.exit(0)

inp = d.get('tool_input') or {}
cmd = inp.get('command')
if not cmd or not isinstance(cmd, str):
    sys.exit(0)

squeez = os.environ['SQUEEZ_BIN']
if cmd.startswith(squeez) or 'squeez wrap' in cmd:
    sys.exit(0)
if cmd.startswith('--no-squeez'):
    inp['command'] = cmd[len('--no-squeez'):].lstrip()
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'updatedInput': inp,
        }
    }))
    sys.exit(0)

try:
    if subprocess.run([squeez, 'should-wrap', cmd], timeout=2).returncode != 0:
        sys.exit(0)
except Exception:
    sys.exit(0)

inp['command'] = squeez + ' wrap ' + shlex.quote(cmd)
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'allow',
        'updatedInput': inp,
    }
}))
"
