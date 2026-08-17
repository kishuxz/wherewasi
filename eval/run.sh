#!/bin/sh
# Evaluation harness. Requires a working WHEREWASI_API_KEY / GROQ_API_KEY.
#
#   eval/run.sh
#
# Every variant runs twice against identical repo state — once with a Claude
# Code session available, once with --no-session — so the only difference
# between a pair is the transcript. Raw session JSON lands in eval/out/.
#
# Each run uses an isolated $HOME, so nothing touches your real ~/.wherewasi
# and nothing reads your real Claude Code sessions.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/eval/out"
CLI="$ROOT/dist/cli.js"
SCEN="$ROOT/eval/scenario.sh"
SESSION="$ROOT/eval/session.py"
MODEL="${WHEREWASI_MODEL:-openai/gpt-oss-120b}"

rm -rf "$OUT"; mkdir -p "$OUT"
( cd "$ROOT" && npm run build >/dev/null 2>&1 )

KEY="${WHEREWASI_API_KEY:-$GROQ_API_KEY}"
if [ -z "$KEY" ]; then echo "no API key in env; source .env first" >&2; exit 1; fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  https://api.groq.com/openai/v1/models -H "Authorization: Bearer $KEY")
if [ "$code" != "200" ]; then echo "credential check failed: HTTP $code" >&2; exit 1; fi
echo "credential OK, model=$MODEL"

# The free tier caps tokens per MINUTE (8,000) as well as per day (200,000).
# One scenario costs ~5,000, so back-to-back runs starve each other and every
# run after the first returns 429. Pace them.
PACE=${WHEREWASI_EVAL_PACE:-70}
pace() {
  if [ -n "$PACED" ]; then
    printf '  (pacing %ss for the 8,000 TPM free-tier limit)\n' "$PACE"
    sleep "$PACE"
  fi
  PACED=1
}

FAIL="FAIL packages/guard/src/index.ts
  error TS2305: Module '@checkpoint/core' has no exported member 'evaluate'.
FAIL packages/core/src/evaluate.test.ts
  ReferenceError: evaluate is not defined
Tests: 2 failed, 1 passed"

# run <label> <note> <piped yes/no> <--big|""> <session on/off>
run() {
  LABEL="$1"; NOTE="$2"; PIPE="$3"; BIG="$4"; SESSION_ON="$5"
  pace

  T=$(mktemp -d); H="$T/home"; R="$T/repo"; mkdir -p "$H"
  sh "$SCEN" "$R" $BIG >/dev/null
  # Written for both arms, so repo and session state are identical and the
  # only difference is whether the tool is allowed to read it.
  python3 "$SESSION" "$R" "$H" >/dev/null

  FLAG=""
  [ "$SESSION_ON" = "off" ] && FLAG="--no-session"

  START=$(python3 -c 'import time;print(time.time())')
  if [ "$PIPE" = "yes" ]; then
    printf '%s\n' "$FAIL" | ( cd "$R" && HOME="$H" WHEREWASI_MODEL="$MODEL" \
      WHEREWASI_API_KEY="$KEY" NO_COLOR=1 node "$CLI" pause $FLAG "$NOTE" ) \
      > "$OUT/$LABEL.stdout" 2>&1 || true
  elif [ -n "$NOTE" ]; then
    ( cd "$R" && HOME="$H" WHEREWASI_MODEL="$MODEL" WHEREWASI_API_KEY="$KEY" NO_COLOR=1 \
      node "$CLI" pause $FLAG "$NOTE" ) > "$OUT/$LABEL.stdout" 2>&1 || true
  else
    ( cd "$R" && HOME="$H" WHEREWASI_MODEL="$MODEL" WHEREWASI_API_KEY="$KEY" NO_COLOR=1 \
      node "$CLI" pause $FLAG ) > "$OUT/$LABEL.stdout" 2>&1 || true
  fi
  END=$(python3 -c 'import time;print(time.time())')

  S=$(find "$H/.wherewasi" -name '*.json' 2>/dev/null | head -1)
  [ -n "$S" ] && cp "$S" "$OUT/$LABEL.json"
  python3 -c "print(f'$LABEL: {($END-$START)*1000:.0f}ms')"
  grep -qiE '413|429|too large|rate limit' "$OUT/$LABEL.stdout" 2>/dev/null && \
    echo "  !! ceiling hit — see $OUT/$LABEL.stdout" || true
}

NOTE="auth token refresh still failing"

echo "--- four variants, each paired with and without the session ---"
run 1-bare-session       ""     no  ""     on
run 1-bare-nosession     ""     no  ""     off
run 2-note-session       "$NOTE" no  ""     on
run 2-note-nosession     "$NOTE" no  ""     off
run 3-piped-session      "$NOTE" yes ""     on
run 3-piped-nosession    "$NOTE" yes ""     off
run 4-trunc-session      "$NOTE" yes --big  on
run 4-trunc-nosession    "$NOTE" yes --big  off

echo "--- burst: 40 agent-written files alongside the real work ---"
pace
T=$(mktemp -d); H="$T/home"; R="$T/repo"; mkdir -p "$H"
sh "$SCEN" "$R" >/dev/null
python3 "$SESSION" "$R" "$H" >/dev/null
mkdir -p "$R/packages/examples/src/generated"
i=1; while [ "$i" -le 40 ]; do
  printf 'export const gen%s = %s;\n' "$i" "$i" > "$R/packages/examples/src/generated/gen$i.ts"
  i=$((i + 1))
done
( cd "$R" && HOME="$H" WHEREWASI_MODEL="$MODEL" WHEREWASI_API_KEY="$KEY" NO_COLOR=1 \
  node "$CLI" pause "$NOTE" ) > "$OUT/5-burst.stdout" 2>&1 || true
S=$(find "$H/.wherewasi" -name '*.json' | head -1); [ -n "$S" ] && cp "$S" "$OUT/5-burst.json"

echo "--- window anchoring: pause, edit two files, pause again ---"
pace
T=$(mktemp -d); H="$T/home"; R="$T/repo"; mkdir -p "$H"
sh "$SCEN" "$R" >/dev/null
python3 "$SESSION" "$R" "$H" >/dev/null
( cd "$R" && HOME="$H" WHEREWASI_API_KEY="$KEY" WHEREWASI_MODEL="$MODEL" NO_COLOR=1 \
  node "$CLI" pause "first" ) >/dev/null 2>&1 || true
A=$(find "$H/.wherewasi" -name '*.json' | head -1); cp "$A" "$OUT/6-anchor-first.json"
pace
sleep 2
printf 'export const extra = 1;\n' >> "$R/packages/collector/src/index.ts"
printf 'export const extra2 = 2;\n' >> "$R/packages/guard/src/index.ts"
( cd "$R" && HOME="$H" WHEREWASI_API_KEY="$KEY" WHEREWASI_MODEL="$MODEL" NO_COLOR=1 \
  node "$CLI" pause "second" ) >/dev/null 2>&1 || true
find "$H/.wherewasi" -name '*.json' | sort | tail -1 | xargs -I{} cp {} "$OUT/6-anchor-second.json"

echo "--- contamination, strong and weak tier ---"
for M in "$MODEL" "llama-3.1-8b-instant"; do
  pace
  T=$(mktemp -d); H="$T/home"; R="$T/repo"; mkdir -p "$H"
  sh "$SCEN" "$R" >/dev/null
  python3 "$SESSION" "$R" "$H" >/dev/null
  SAFE=$(printf '%s' "$M" | tr '/.' '__')
  ( cd "$R" && HOME="$H" WHEREWASI_MODEL="$M" WHEREWASI_API_KEY="$KEY" NO_COLOR=1 \
    node "$CLI" pause "$NOTE" ) > "$OUT/7-contam-$SAFE.stdout" 2>&1 || true
  S=$(find "$H/.wherewasi" -name '*.json' 2>/dev/null | head -1)
  [ -n "$S" ] && cp "$S" "$OUT/7-contam-$SAFE.json"
done

echo
echo "--- pairs ---"
python3 "$ROOT/eval/score.py" "$OUT" || true
echo
echo "raw output in $OUT"
