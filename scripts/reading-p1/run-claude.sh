#!/usr/bin/env bash
# Claude reader, primary path (plan §5.3): tool-less `claude -p` in the staged case directory.
# Usage: run-claude.sh <case-dir> <opus|haiku> <1|2>
#   turn 1 reads PROMPT.md → out1.json; turn 2 resumes the turn-1 session with TURN2.md → out2.json.
set -euo pipefail
B="$1"; MODEL="$2"; TURN="$3"
case "$B" in /tmp/reading-p1.*) ;; *) echo "refused: case dir must be /tmp/reading-p1.*" >&2; exit 2 ;; esac
case "$MODEL" in opus|haiku) ;; *) echo "refused: model must be opus or haiku" >&2; exit 2 ;; esac
if [ "$TURN" = "1" ]; then
  cd "$B" && claude -p --tools "" --strict-mcp-config --safe-mode --disable-slash-commands \
    --model "$MODEL" --output-format json < PROMPT.md > out1.json
elif [ "$TURN" = "2" ]; then
  SESSION="$(jq -r .session_id "$B/out1.json")"
  cd "$B" && claude -p --tools "" --strict-mcp-config --safe-mode --disable-slash-commands \
    --model "$MODEL" --output-format json --resume "$SESSION" < TURN2.md > out2.json
else
  echo "refused: turn must be 1 or 2" >&2; exit 2
fi
