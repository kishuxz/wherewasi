import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "./types.js";
import type { Provider, ProviderRequest, ProviderResult } from "./types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";

const TIMEOUT_MS = 30_000;

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey: string; model?: string }) {
    this.model = opts.model || ANTHROPIC_DEFAULT_MODEL;
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        // Latency over depth: the evidence is all in the prompt already and the
        // user is mid-interruption.
        thinking: { type: "disabled" },
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 429) {
        throw new ProviderError(`Anthropic rate limit reached (${message})`, "rate_limit", status);
      }
      if (status === 401 || status === 403) {
        throw new ProviderError(`Anthropic rejected the API key (${message})`, "auth", status);
      }
      if (status === undefined) {
        throw new ProviderError(`could not reach Anthropic (${message})`, "network");
      }
      throw new ProviderError(`Anthropic returned ${status} (${message})`, "http", status);
    }

    if (response.stop_reason === "refusal") {
      throw new ProviderError("the model declined to analyze this state", "refusal");
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (!text.trim()) {
      throw new ProviderError("Anthropic returned an empty completion", "http");
    }

    return { text, model: response.model };
  }
}
