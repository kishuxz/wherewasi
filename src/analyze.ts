import { redact } from "./redact.js";
import { ProviderError, selectProvider } from "./providers/index.js";
import type { Provider, ProviderEnv } from "./providers/index.js";
import type { Analysis, CapturedState } from "./types.js";

/**
 * Reasoning models bill their thinking against the completion budget, so this
 * has to cover the trace as well as the ~400 tokens of JSON we actually want.
 */
const MAX_TOKENS = 2500;

const SYSTEM = `You are writing a note to a developer who was interrupted an hour ago and has just sat back down. They can already see their own diff. Your note has to supply the one thing the diff cannot: what problem they were in the middle of solving.

THE DIFF IS EVIDENCE, NOT THE SUBJECT.
Treat every change as a clue about a goal that is never stated anywhere. The edits are the footprints; you are describing where the person was walking, not the shape of the footprints. If a sentence you write would still be true if you had only read the diff and understood nothing about the problem, delete it.

The central question is: WHY ARE THESE PARTICULAR FILES OPEN TOGETHER? A rename in one package, a debug print in another, and a failing test in a third are not three tasks — they are almost always one investigation. Name that investigation. If the note the developer typed states a problem, that problem is the goal, and every edit should be explained as a move toward it — not the other way round. Never claim an edit was made "to accommodate" or "in order to enable" another edit unless the evidence actually shows that dependency.

FIELD RULES

The illustrations below use an unrelated imaginary project (a PDF exporter) purely to show the FORM of a good answer. Never reuse their wording, their subject matter, or their nouns. If your answer mentions PDFs, pagination, or fonts, you have copied the illustration instead of reading the evidence — start over from the actual repository in front of you.

summary — at most 3 sentences, second person, begins "You were". The first sentence must name the PROBLEM, not the edits. Do not list what changed; do not name refactors, renames, or files in the first sentence. Form — bad: "You were renaming renderPage to renderSheet across the exporter and its tests." Form — good: "You were chasing why long documents lose their last page on export."

hypothesis — second person. The specific, falsifiable belief they were testing: something that could turn out to be wrong. State the suspected mechanism. Form — bad: "You were improving the pagination handling." Form — good: "You suspected the page counter is computed before the final flush, so the last buffer never gets counted." Do not restate the edits here.

ruled_out — what the evidence shows they already ELIMINATED. This is the highest-risk field: the developer will trust it and skip that suspect. A wrong entry costs them the hour you are trying to save.
  Each entry must point to evidence of abandonment: code deleted in the diff, an approach reverted in the recent commits, a commented-out block, a debug line removed, or the note saying something did not work.
  These are NOT eliminations — never emit them:
    * work still outstanding ("guard has not been updated yet")
    * the change itself relabelled ("keeping the old name" when they renamed it)
    * anything you inferred only because it seems plausible
  If you cannot point to the specific evidence of abandonment, return []. An empty array is a correct and common answer. Returning [] is strictly better than guessing.

working_set — the files that matter to the hypothesis, not simply the files that changed. Include a file that is central to the problem even if it has no edits, and say why it matters to the investigation rather than what was changed in it. Each entry exactly \`path — clause\`, using a real path (never a glob or a directory wildcard). Most important first.

next_step — the single concrete action to take right now, phrased as an instruction. It must be executable without further decisions.

Prefer honest uncertainty to confident invention: "you appeared to be", "the evidence suggests". If the evidence does not reveal the goal, say that plainly in the summary rather than inventing one.

Respond with a single JSON object and nothing else — no prose, no markdown fences. Shape:
{"summary": string, "hypothesis": string, "ruled_out": string[], "working_set": string[], "next_step": string}`;

export const SYSTEM_PROMPT = SYSTEM;

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

/**
 * Pulls a JSON object out of a response that may have stray prose or fences.
 *
 * With response_format=json_object this is a no-op on the happy path, but it
 * stays because Anthropic has no equivalent directive and any model can ignore
 * one.
 */
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
  /** Which model answered, for reporting only — not persisted. */
  model: string | null;
}

export interface AnalyzeOptions {
  /** Inject a provider directly; otherwise one is selected from env. */
  provider?: Provider | null;
  env?: ProviderEnv;
}

/**
 * The single network call this tool makes. Returns an error string rather than
 * throwing — a failed analysis must never cost the user their captured state.
 */
export async function analyze(
  state: CapturedState,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  let provider = opts.provider ?? null;

  if (!provider) {
    const selection = selectProvider(opts.env ?? process.env);
    if (!selection.provider) {
      return { analysis: null, error: selection.reason, model: null };
    }
    provider = selection.provider;
  }

  try {
    const result = await provider.complete({
      system: SYSTEM,
      user: buildPrompt(state),
      maxTokens: MAX_TOKENS,
    });
    return { analysis: parseAnalysis(result.text), error: null, model: result.model };
  } catch (err) {
    if (err instanceof ProviderError) {
      // Rate limiting is the expected failure on a free tier, so say so plainly
      // instead of surfacing a raw HTTP message.
      const message =
        err.kind === "rate_limit"
          ? `${err.message} — state saved without analysis; try again in a minute`
          : err.message;
      return { analysis: null, error: message, model: provider.model };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { analysis: null, error: message, model: provider.model };
  }
}
