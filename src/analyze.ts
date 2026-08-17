import Anthropic from "@anthropic-ai/sdk";
import { redact } from "./redact.js";
import type { Analysis, CapturedState } from "./types.js";

export const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;
const TIMEOUT_MS = 25_000;

const SYSTEM = `You reconstruct a developer's mental state at the moment they were interrupted.

You are given the raw evidence left behind: a git diff, recent commits, working tree status, recently touched files, an optional note the developer typed, and optionally the output of a command they were running (often a failing test).

Your job is to infer INTENT and REASONING — the working hypothesis they were holding in their head. A mechanical description of the diff is worthless to them: they can run \`git diff\` themselves. What they cannot recover is WHY those changes exist, what question they were answering, and what they had already eliminated.

Rules:
- Reason backwards from the evidence to the goal. A half-written guard clause plus a failing auth test means they suspected the guard was the problem — say that, not "added an if statement".
- ruled_out must be grounded in evidence: code that was deleted, an approach that was reverted, a commented-out block, a debug line that has since been removed, a note that says something didn't work. If the evidence supports nothing, return an empty array. Never invent eliminations to fill space.
- working_set is files that matter to the hypothesis, not simply files that changed. Format each entry exactly as \`path — one clause on why it matters\` (em dash separator). Order by importance.
- next_step is the single concrete action to take on returning, phrased as an instruction.
- summary is at most 3 sentences, second person, and starts with "You were".
- Prefer honest uncertainty over confident fabrication: "you appeared to be", "the diff suggests".

Respond with a single JSON object and nothing else — no prose, no markdown fences. Shape:
{"summary": string, "hypothesis": string, "ruled_out": string[], "working_set": string[], "next_step": string}`;

function section(title: string, body: string): string {
  if (!body || !body.trim()) return "";
  return `<${title}>\n${body.trim()}\n</${title}>\n\n`;
}

/** Builds the user-turn prompt. Everything here is redacted already. */
export function buildPrompt(state: CapturedState): string {
  const g = state.git;
  let out = "";

  if (state.note) out += section("developer_note", redact(state.note));
  if (state.input) out += section("captured_command_output", redact(state.input));

  if (g.isRepo) {
    out += section("branch", g.branch);
    out += section("recent_commits", redact(g.log));
    out += section("working_tree_status", redact(g.status));
    out += section("unstaged_diff", redact(g.diff) || "(no unstaged changes)");
    out += section("staged_diff", redact(g.stagedDiff) || "(no staged changes)");
  } else {
    out += section("branch", "(not a git repository)");
  }

  out += section(
    "files_modified_in_last_2_hours",
    state.recentFiles.length
      ? state.recentFiles.map((f) => `${f.path}\t${f.mtime}`).join("\n")
      : "(none)",
  );

  out += "Reconstruct what this developer was thinking. Return only the JSON object.";
  return out;
}

/** Pulls a JSON object out of a response that may have stray prose or fences. */
export function parseAnalysis(text: string): Analysis {
  let candidate = text.trim();

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidate = fenced[1].trim();

  if (!candidate.startsWith("{")) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object in model response");
    candidate = candidate.slice(start, end + 1);
  }

  const raw = JSON.parse(candidate) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];

  const analysis: Analysis = {
    summary: str(raw["summary"]),
    hypothesis: str(raw["hypothesis"]),
    ruled_out: arr(raw["ruled_out"]),
    working_set: arr(raw["working_set"]),
    next_step: str(raw["next_step"]),
  };

  if (!analysis.summary) throw new Error("model response had no summary");
  return analysis;
}

export interface AnalyzeResult {
  analysis: Analysis | null;
  error: string | null;
}

/**
 * The single network call this tool makes. Returns an error string rather than
 * throwing — a failed analysis must never cost the user their captured state.
 */
export async function analyze(
  state: CapturedState,
  opts: { apiKey?: string | undefined } = {},
): Promise<AnalyzeResult> {
  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    return { analysis: null, error: "ANTHROPIC_API_KEY is not set" };
  }

  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Latency matters more than depth here — pause must not interrupt the
      // interruption. The inference is bounded and the evidence is all present.
      thinking: { type: "disabled" },
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(state) }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (response.stop_reason === "refusal") {
      return { analysis: null, error: "the model declined to analyze this state" };
    }

    return { analysis: parseAnalysis(text), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { analysis: null, error: message };
  }
}
