import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPrompt, SYSTEM_PROMPT } from "./analyze.js";
import { isLocalEndpoint, OpenAICompatibleProvider } from "./providers/index.js";
import { redact } from "./redact.js";
import { rootDir } from "./storage.js";
import type { Provider } from "./providers/types.js";
import type { Transcript } from "./transcript.js";
import type { CapturedState } from "./types.js";

/** Local endpoints never need a hosted-data approval. */
export function hostedDestination(provider: Provider): string | null {
  if (provider instanceof OpenAICompatibleProvider) {
    return isLocalEndpoint(provider.baseUrl) ? null : provider.baseUrl;
  }
  const baseUrl = process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com";
  return isLocalEndpoint(baseUrl) ? null : baseUrl;
}

function consentHash(destination: string, repository: string): string {
  return createHash("sha256").update(destination).update("\0").update(repository).digest("hex");
}

function consentFile(destination: string, repository: string, home?: string): string {
  return path.join(
    rootDir(home),
    `hosted-consent-${consentHash(destination, repository).slice(0, 16)}.json`,
  );
}

export async function hasHostedConsent(
  destination: string,
  repository: string,
  home?: string,
): Promise<boolean> {
  try {
    const saved = JSON.parse(
      await readFile(consentFile(destination, repository, home), "utf8"),
    ) as {
      consentHash?: string;
    };
    return saved.consentHash === consentHash(destination, repository);
  } catch {
    return false;
  }
}

export async function recordHostedConsent(
  destination: string,
  repository: string,
  home?: string,
): Promise<void> {
  const root = rootDir(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await writeFile(
    consentFile(destination, repository, home),
    `${JSON.stringify({ consentHash: consentHash(destination, repository), approvedAt: new Date().toISOString() })}\n`,
    { mode: 0o600, flag: "w" },
  );
}

/** The prompt text passed to either provider's complete() call. */
export function hostedPreview(state: CapturedState, transcript?: Transcript | null): string {
  return `SYSTEM PROMPT\n${SYSTEM_PROMPT}\n\nUSER PROMPT\n${buildPrompt(state, transcript)}\n`;
}

/** Shared at-rest scrub for human and agent checkpoints. */
export function redactCapturedState(state: CapturedState): CapturedState {
  return {
    ...state,
    git: {
      ...state.git,
      diff: redact(state.git.diff),
      stagedDiff: redact(state.git.stagedDiff),
      status: redact(state.git.status),
      log: redact(state.git.log),
    },
    note: state.note ? redact(state.note) : null,
    input: state.input ? redact(state.input) : null,
    recentFiles: state.recentFiles.map((file) => ({ ...file, path: redact(file.path) })),
  };
}
