/**
 * Best-effort secret scrubbing applied to everything before it leaves the
 * machine. This is a safety net, not a guarantee — it catches the obvious
 * shapes (provider key prefixes, `TOKEN=value` assignments), not entropy.
 */

export const REDACTED = "[REDACTED]";

interface Rule {
  name: string;
  pattern: RegExp;
  replace: (...args: string[]) => string;
}

const RULES: Rule[] = [
  {
    // Anthropic / OpenAI / Stripe style: sk-…, sk-ant-api03-…, sk_live_…
    name: "sk-prefixed key",
    pattern: /\bsk[-_][A-Za-z0-9_-]{8,}/g,
    replace: () => REDACTED,
  },
  {
    // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
    name: "github token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: () => REDACTED,
  },
  {
    // AWS access key IDs
    name: "aws access key id",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{12,}/g,
    replace: () => REDACTED,
  },
  {
    // Bearer <token>
    name: "bearer token",
    pattern: /\b([Bb]earer\s+)[A-Za-z0-9._~+/=-]{12,}/g,
    replace: (_m: string, prefix: string) => `${prefix}${REDACTED}`,
  },
  {
    // key = value / "key": "value" / key: value
    name: "secret assignment",
    pattern:
      /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)(["'`]?)([^\s"'`,;)}\]]+)\2/gi,
    replace: (_m: string, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  },
];

/** Redacts secrets in a blob of text (diffs, logs, notes, piped output). */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: unknown[]) => string,
    );
  }
  return out;
}

/** True if `redact` would change the text. Used to warn the user. */
export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}
