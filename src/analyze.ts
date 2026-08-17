import { redact } from "./redact.js";
import { ProviderError, selectProvider } from "./providers/index.js";
import type { Provider, ProviderEnv } from "./providers/index.js";
import type { Transcript } from "./transcript.js";
import type { Analysis, CapturedState } from "./types.js";

/**
 * Reasoning models bill their thinking against the completion budget, so this
 * has to cover the trace as well as the ~400 tokens of JSON we actually want.
 */
const MAX_TOKENS = 2500;

const SYSTEM = `You are writing a note to a developer who was interrupted an hour ago and has just sat back down. They can already see their diff. Supply the one thing it cannot: the problem they were solving.

If an <agent_session> is present it OUTRANKS every other section. It is the developer stating their intent in their own words; the diff is only the residue those intentions left. Where the two disagree, the session is right and the diff is stale. Never contradict an explicitly stated goal because the edits look like something else.

THE DIFF IS EVIDENCE, NOT THE SUBJECT. Edits are footprints; describe where the person was walking, not the shape of the prints. If a sentence would still be true having read only the diff and understood nothing of the problem, delete it.

Ask: WHY ARE THESE FILES OPEN TOGETHER? A rename here, a debug print there, a failing test elsewhere are one investigation, not three tasks. Name it. If the developer's note states a problem, that is the goal and every edit is a move toward it — never the reverse. Do not claim an edit exists "to accommodate" another unless the evidence shows that dependency.

Examples below use an unrelated imaginary project (a PDF exporter) to show FORM only. Never reuse their wording, subject or nouns. If your answer mentions PDFs, pagination or fonts you have copied the example instead of reading the evidence — start over from the actual repository.

summary — max 3 sentences, second person, begins "You were". First sentence names the PROBLEM. Do not list what changed; no refactors, renames or filenames in it. Bad: "You were renaming renderPage to renderSheet across the exporter." Good: "You were chasing why long documents lose their last page on export."

hypothesis — second person, the specific falsifiable belief being tested, stating the suspected mechanism. Bad: "You were improving pagination handling." Good: "You suspected the page counter is computed before the final flush, so the last buffer is never counted." Do not restate edits.

ruled_out — candidate CAUSES of the problem that were tried and dismissed. Highest-risk field: a wrong entry makes them skip a live suspect. Every entry needs evidence of an abandoned attempt — code deleted, an approach reverted, a commented-out block, a removed debug line, or the note saying something failed.
  These are NOT eliminations, however reasonable they sound:
    * work still outstanding ("guard has not been updated yet")
    * work they COMPLETED — a finished rename, migration or cleanup is not a dismissed cause, even if you can argue it removes one
    * the change itself restated as a cause that was excluded
    * anything merely plausible
  Ask of each entry: did they try this as a fix for the problem and reject it? If not, drop it. Without evidence of a rejected attempt return []. Empty is common, correct, and strictly better than guessing.

working_set — exactly two kinds of file:
  1. Files that matter to the hypothesis. Say why they matter to the investigation, not what changed in them.
  2. BLOCKERS — anything the evidence shows is stopping the next step: a file that fails to compile, the source of a failing test, an export something still imports under its old name. Include these even if unrelated to the hypothesis and even if never edited; a file that fails to build is load-bearing regardless. If the captured output contains an error, the file it names is a blocker. Name the blocker in the clause, not just the file.
  Each entry exactly \`path — clause\`. The path must be one literal file copied from the evidence — for a blocker, the exact path the error or stack trace names. Never a glob, a wildcard, a directory, or a pattern containing * or **. Blockers first.

next_step — one concrete instruction, executable without further decisions. If a blocker exists, clearing it IS the next step; never tell them to run something that cannot currently run.

Blockers appear in working_set and next_step ONLY — never in summary or hypothesis, which describe the problem, not the obstacle. A broken build is not what they were thinking about.

Prefer honest uncertainty to invention. If the evidence does not reveal the goal, say so in the summary rather than inventing one.

Respond with one JSON object, no prose, no fences:
{"summary": string, "hypothesis": string, "ruled_out": string[], "working_set": string[], "next_step": string}`;

export const SYSTEM_PROMPT = SYSTEM;

function section(title: string, body: string): string {
  if (!body || !body.trim()) return "";
  return `<${title}>\n${body.trim()}\n</${title}>\n\n`;
}

/** Builds the user-turn prompt. Everything here is redacted already. */
export function buildPrompt(state: CapturedState, transcript?: Transcript | null): string {
  const g = state.git;
  let out = "";

  // First, because it is the strongest evidence in the payload.
  if (transcript?.content.length) {
    const body = transcript.content
      .map((t) => `${t.role === "user" ? "DEVELOPER" : "ASSISTANT"}: ${redact(t.text)}`)
      .join("\n\n");
    out += section("agent_session", body);
  }

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

  // Storage keeps all 40 for `resume --open`; the prompt does not need them.
  // Bulk-written files are the low-signal ones by definition, so a handful
  // plus a count conveys the same context at a fraction of the token cost —
  // which matters because prompt length competes with the diff for one budget.
  // The payload already sits near the free-tier ceiling, so transcript content
  // has to displace rather than stack. Bulk-written files are the lowest-signal
  // thing here by construction, so they go first, and the individual list is
  // capped hard — both cheaper than dropping a turn the developer wrote.
  const hasSession = Boolean(transcript?.content.length);
  const BULK_SAMPLE = hasSession ? 0 : 5;
  const INDIVIDUAL_LIMIT = hasSession ? 12 : state.recentFiles.length;
  const individual = state.recentFiles.filter((f) => !f.bulk).slice(0, INDIVIDUAL_LIMIT);
  const bulk = state.recentFiles.filter((f) => f.bulk);

  const render = (f: (typeof state.recentFiles)[number]) =>
    `${f.path}\t${f.mtime}\t[${f.inGit ? "git-changed" : "mtime-only"}]`;

  const lines = individual.map(render);
  if (bulk.length && BULK_SAMPLE === 0) {
    lines.push(`… and ${bulk.length} more files from a bulk edit, omitted`);
  } else if (bulk.length) {
    lines.push(...bulk.slice(0, BULK_SAMPLE).map((f) => `${render(f)} [bulk-edit]`));
    if (bulk.length > BULK_SAMPLE) {
      lines.push(`… and ${bulk.length - BULK_SAMPLE} more files from the same bulk edit`);
    }
  }

  out += section("recently_touched_files", lines.length ? lines.join("\n") : "(none)");

  if (bulk.length && BULK_SAMPLE > 0) {
    out += section(
      "reading_the_file_list",
      "Files tagged bulk-edit were written together in seconds — a codemod, a formatter, or an agent — so they show attention far less reliably than files touched individually. Weight them below the rest. Files tagged git-changed are the strongest signal; mtime-only files may just have been read or rebuilt.",
    );
  }

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

/**
 * Small models reproduce the prompt's worked examples verbatim instead of
 * reasoning, and the result is fluent, well-formed and about the wrong
 * software entirely. The examples are deliberately from an unrelated domain so
 * this is obvious to a human, but nothing was catching it automatically.
 */
export function copiedFromPrompt(analysis: Analysis): boolean {
  return [analysis.summary, analysis.hypothesis].some(
    (field) => field.length > 20 && SYSTEM.includes(field),
  );
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
  /** Agent session for this repo, weighted above the diff when present. */
  transcript?: Transcript | null;
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
      user: buildPrompt(state, opts.transcript ?? null),
      maxTokens: MAX_TOKENS,
    });
    const analysis = parseAnalysis(result.text);
    if (copiedFromPrompt(analysis)) {
      return {
        analysis: null,
        error: `${result.model} returned a prompt example verbatim instead of analyzing the repository — use a larger model`,
        model: result.model,
      };
    }
    return { analysis, error: null, model: result.model };
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
