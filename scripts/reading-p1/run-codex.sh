#!/usr/bin/env bash
# Codex reader (gpt-6.1-sol, mandatory non-Claude reader; plan §5.3) in an isolated CODEX_HOME.
# Usage: run-codex.sh <case-dir> <meta-dir> <1|2|cleanup>
#   turn 1: fresh CODEX_HOME holding only auth.json; PROMPT.md (+ schema1.json) → out1.json, events1.jsonl
#   turn 2: `codex exec resume` of the turn-1 thread with TURN2.md (+ schema2.json) → out2.json, events2.jsonl
#   cleanup: removes the CODEX_HOME. <meta-dir> lies outside the case dir and records CODEX_HOME listings + stderr.
set -euo pipefail
B="$1"; META="$2"; TURN="$3"
case "$B" in /tmp/reading-p1.*) ;; *) echo "refused: case dir must be /tmp/reading-p1.*" >&2; exit 2 ;; esac
case "$META" in "$B"|"$B"/*) echo "refused: meta dir inside the case dir" >&2; exit 2 ;; esac
mkdir -p -m 700 "$META"
F=(--ignore-user-config -c features.memories=false -c 'sandbox_mode="read-only"' -m gpt-6.1-sol --skip-git-repo-check --json)
# `-s` is not accepted by `codex exec resume`; sandbox goes via -c on both turns (Codex P1 r3).
schema_args() { if [ -f "$B/schema$1.json" ]; then printf '%s\n' --output-schema "$B/schema$1.json"; fi; }

if [ "$TURN" = "1" ]; then
  CODEX_HOME="$(mktemp -d /tmp/reading-p1-codex.XXXXXXXX)"; export CODEX_HOME
  printf '%s\n' "$CODEX_HOME" > "$META/codex_home.txt"
  cp ~/.codex/auth.json "$CODEX_HOME/"; chmod 600 "$CODEX_HOME/auth.json"
  ls -A "$CODEX_HOME" > "$META/codex_home_before1.txt"
  mapfile -t S < <(schema_args 1)
  cd "$B" && codex exec "${F[@]}" -C "$B" "${S[@]}" -o "$B/out1.json" - < PROMPT.md > events1.jsonl 2> "$META/stderr1.txt"
elif [ "$TURN" = "2" ]; then
  CODEX_HOME="$(cat "$META/codex_home.txt")"; export CODEX_HOME
  ls -A "$CODEX_HOME" > "$META/codex_home_before2.txt"
  THREAD="$(jq -r 'select(.type=="thread.started").thread_id' "$B/events1.jsonl")"
  mapfile -t S < <(schema_args 2)
  cd "$B" && codex exec resume "${F[@]}" "${S[@]}" -o "$B/out2.json" \
    "$THREAD" - < TURN2.md > events2.jsonl 2> "$META/stderr2.txt"
elif [ "$TURN" = "cleanup" ]; then
  if [ -f "$META/codex_home.txt" ]; then
    CODEX_HOME="$(cat "$META/codex_home.txt")"
    case "$CODEX_HOME" in /tmp/reading-p1-codex.*) rm -rf "$CODEX_HOME" ;; esac
  fi
else
  echo "refused: turn must be 1, 2 or cleanup" >&2; exit 2
fi
