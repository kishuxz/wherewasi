#!/bin/sh
# Builds the evaluation scenario: a half-finished rename of `evaluate` to
# `evaluateRun` across a TypeScript monorepo, with `guard` missed.
#
# Deliberately contains NO comment that explains the why in prose. This is an
# inference test — if the diff says "investigating token refresh", the model is
# doing reading comprehension, not reconstruction.
#
# Usage: scenario.sh <target-dir> [--big]
#   --big pads the diff past the 8000-char cap to force truncation.
set -e
DIR="$1"
BIG="${2:-}"

mkdir -p "$DIR"/packages/core/src "$DIR"/packages/cli/src \
         "$DIR"/packages/collector/src "$DIR"/packages/guard/src
cd "$DIR"
git init -q .
git config user.email eval@example.test
git config user.name "Eval"

# ---- committed baseline: everything uses the old name, everything builds ----
cat > packages/core/src/index.ts <<'EOF'
export interface RunResult {
  id: string;
  ok: boolean;
  durationMs: number;
}

export function evaluate(id: string, durationMs: number): RunResult {
  return { id, ok: durationMs < 30_000, durationMs };
}

export function summarise(results: RunResult[]): string {
  const failed = results.filter((r) => !r.ok).length;
  return `${results.length} runs, ${failed} failed`;
}
EOF

cat > packages/cli/src/index.ts <<'EOF'
import { evaluate, summarise } from "@checkpoint/core";

export function main(ids: string[]): string {
  return summarise(ids.map((id) => evaluate(id, 1000)));
}
EOF

cat > packages/collector/src/index.ts <<'EOF'
import { evaluate } from "@checkpoint/core";

let sinkToken = "";

export function setSinkToken(token: string): void {
  sinkToken = token;
}

export function collect(id: string): unknown {
  if (!sinkToken) throw new Error("no sink token");
  return evaluate(id, 1200);
}
EOF

cat > packages/guard/src/index.ts <<'EOF'
import { evaluate } from "@checkpoint/core";

export function guard(id: string): boolean {
  return evaluate(id, 500).ok;
}
EOF

cat > packages/core/src/evaluate.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { evaluate } from "./index.js";

describe("evaluate", () => {
  it("passes fast runs", () => {
    expect(evaluate("a", 10).ok).toBe(true);
  });
});
EOF

git add -A
git commit -qm "checkpoint: initial run evaluation"

# ---- the work in progress ----
# core: renamed. cli + collector: call sites updated. guard: MISSED.
cat > packages/core/src/index.ts <<'EOF'
export interface RunResult {
  id: string;
  ok: boolean;
  durationMs: number;
}

export function evaluateRun(id: string, durationMs: number): RunResult {
  return { id, ok: durationMs < 30_000, durationMs };
}

export function summarise(results: RunResult[]): string {
  const failed = results.filter((r) => !r.ok).length;
  return `${results.length} runs, ${failed} failed`;
}
EOF

cat > packages/cli/src/index.ts <<'EOF'
import { evaluateRun, summarise } from "@checkpoint/core";

export function main(ids: string[]): string {
  return summarise(ids.map((id) => evaluateRun(id, 1000)));
}
EOF

cat > packages/core/src/evaluate.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { evaluateRun } from "./index.js";

describe("evaluateRun", () => {
  it("passes fast runs", () => {
    expect(evaluateRun("a", 10).ok).toBe(true);
  });
});
EOF

# collector: renamed call site, plus the token-age check, the stub that only
# bumps a timestamp, and a debug print left mid-investigation.
cat > packages/collector/src/index.ts <<'EOF'
import { evaluateRun } from "@checkpoint/core";

let sinkToken = "";
let tokenIssuedAt = 0;

const TOKEN_MAX_AGE_MS = 3_600_000;

export function setSinkToken(token: string): void {
  sinkToken = token;
  tokenIssuedAt = Date.now();
}

function refreshSinkToken(): void {
  tokenIssuedAt = Date.now();
}

export function collect(id: string): unknown {
  const age = Date.now() - tokenIssuedAt;
  console.error("age", age, "token", sinkToken.slice(0, 4), "max", TOKEN_MAX_AGE_MS);
  if (age > TOKEN_MAX_AGE_MS) {
    refreshSinkToken();
  }
  if (!sinkToken) throw new Error("no sink token");
  return evaluateRun(id, 1200);
}
EOF

if [ "$BIG" = "--big" ]; then
  # Pad past DIFF_LIMIT (8000) so truncation fires. Mechanical churn only —
  # it must not carry signal, or it changes what is being measured.
  i=1
  while [ "$i" -le 240 ]; do
    printf 'export const pad%s = { id: "pad-%s", ok: true, durationMs: %s };\n' "$i" "$i" "$i" \
      >> packages/core/src/index.ts
    i=$((i + 1))
  done
fi

# Mixed staged and unstaged, as specified.
git add packages/core/src/index.ts packages/cli/src/index.ts
# collector + the test stay unstaged; guard is untouched and still imports
# `evaluate`, which no longer exists.

echo "$DIR"
