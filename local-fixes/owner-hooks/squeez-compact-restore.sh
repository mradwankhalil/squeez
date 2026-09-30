#!/usr/bin/env bash
# squeez post-compaction state restore. USER-OWNED.
#
# Re-emits `squeez compact-summary` under SessionStart, because PostCompact
# cannot inject context on current Claude Code builds (see X-07, issue #225).
#
# HARD SAFETY LIMITS — read before editing.
#   squeez's compact-summary has a backslash-doubling bug: tracked Windows paths
#   get re-escaped on every cycle, so `C:\Users\...` becomes `C:\\\\Users`, then
#   8, 16, 32 ... Measured 2026-09-10: a single 1,048,576-character backslash run
#   (2^20) inside a 7,340,436-character payload that was 100% redundant escaping,
#   i.e. ~2,000,000 tokens.
#
#   Injecting that straight after a compaction would be catastrophic: it undoes
#   the compaction and can blow the window instantly. So this hook NEVER trusts
#   the payload. It sanitises, then enforces a hard byte cap, and emits nothing
#   at all if the result still looks wrong. Silence is always the safe outcome.
set -uo pipefail

MAX_CHARS=8000          # hard ceiling on injected context
MAX_RAW_BYTES=2000000   # refuse to even parse anything larger than this

# Hook payload arrives as JSON on stdin. Consume it before anything else can
# write to stdout, or the status banner corrupts our JSON.
[ -t 0 ] && exit 0
_stdin=$(cat 2>/dev/null || true)
[ -z "$_stdin" ] && exit 0

SQUEEZ="$HOME/.claude/squeez/bin/squeez"
if [ ! -x "$SQUEEZ" ]; then
    _sq=$(command -v squeez 2>/dev/null || true)
    [ -n "$_sq" ] && SQUEEZ="$_sq"
fi
[ ! -x "$SQUEEZ" ] && exit 0

# Interpreter probe: on Windows `python3` often resolves to the Microsoft Store
# alias, which passes `command -v` and then exits non-zero. Probe for real.
SQUEEZ_PY=""
for _cand in python3 python py; do
    if command -v "$_cand" >/dev/null 2>&1 && "$_cand" -c "pass" >/dev/null 2>&1; then
        SQUEEZ_PY="$_cand"; break
    fi
done
[ -z "$SQUEEZ_PY" ] && exit 0

_src=$(printf '%s' "$_stdin" | "$SQUEEZ_PY" -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('source', '') if isinstance(d, dict) else '')
except Exception:
    print('')
" 2>/dev/null || echo "")

[ "$_src" = "compact" ] || exit 0

# Emit ONLY the JSON object below. Any other stdout byte corrupts it.
"$SQUEEZ" compact-summary 2>/dev/null | "$SQUEEZ_PY" -c "
import json, re, sys

MAX_CHARS = $MAX_CHARS
MAX_RAW   = $MAX_RAW_BYTES

raw = sys.stdin.read(MAX_RAW + 1)
if len(raw) > MAX_RAW:
    sys.exit(0)                      # runaway payload: stay silent

try:
    d = json.load(io_obj) if False else json.loads(raw)
    ctx = (d.get('hookSpecificOutput') or {}).get('additionalContext', '')
except Exception:
    sys.exit(0)

if not isinstance(ctx, str) or not ctx.strip():
    sys.exit(0)

# Collapse the backslash-doubling runaway: any run of 2+ backslashes becomes one.
ctx = re.sub(r'\\\\{2,}', r'\\\\', ctx)
# Collapse any other pathological single-character runs (>200 identical chars).
ctx = re.sub(r'(.)\\1{200,}', r'\\1', ctx)
ctx = ctx.strip()

if not ctx:
    sys.exit(0)

if len(ctx) > MAX_CHARS:
    ctx = ctx[:MAX_CHARS] + ' [truncated by squeez-compact-restore.sh]'

json.dump({'hookSpecificOutput': {'hookEventName': 'SessionStart',
                                  'additionalContext': ctx}}, sys.stdout)
" 2>/dev/null || true

exit 0
