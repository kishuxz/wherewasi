/** The one thing a provider has to do: turn a system+user prompt into text. */
export interface ProviderRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface ProviderResult {
  text: string;
  /** Echoed back so the session records which model actually answered. */
  model: string;
}

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  complete(req: ProviderRequest): Promise<ProviderResult>;
}

export type ProviderName = "openai-compatible" | "anthropic";

/**
 * Why a call failed, in the terms `pause` needs to report.
 *
 * `rate_limit` is broken out because the Groq free tier hits it in normal use
 * and the user needs to be told that specifically — "try again in a minute" is
 * actionable, "request failed" is not.
 */
export type ProviderErrorKind = "auth" | "rate_limit" | "http" | "network" | "refusal";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
