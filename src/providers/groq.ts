import { ProviderError } from "./types.js";
import type { Provider, ProviderRequest, ProviderResult } from "./types.js";

export const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Chosen by listing GET /models on a live free-tier account rather than from
 * memory: a 120B reasoning-tuned MoE with a 131k context window, and the
 * fastest of the reasoning-capable models on the account. Override with
 * GROQ_MODEL to compare tiers without touching code.
 */
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

const TIMEOUT_MS = 30_000;

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string; type?: string };
}

export class GroqProvider implements Provider {
  readonly name = "groq" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || GROQ_DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl || GROQ_DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          // Supported by every text model on the account; makes the happy path
          // exact JSON instead of something the tolerant parser has to rescue.
          response_format: { type: "json_object" },
          max_completion_tokens: req.maxTokens,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`could not reach Groq (${message})`, "network");
    }

    const raw = await response.text();
    let body: ChatCompletionResponse = {};
    try {
      body = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      // Fall through — a non-JSON body is only interesting for its status.
    }

    if (!response.ok) {
      const detail = body.error?.message ?? raw.slice(0, 200);
      if (response.status === 429) {
        throw new ProviderError(
          `Groq rate limit reached (${detail})`,
          "rate_limit",
          response.status,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(`Groq rejected the API key (${detail})`, "auth", response.status);
      }
      throw new ProviderError(
        `Groq returned ${response.status} (${detail})`,
        "http",
        response.status,
      );
    }

    const choice = body.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (!text.trim()) {
      throw new ProviderError("Groq returned an empty completion", "http", response.status);
    }

    return { text, model: body.model ?? this.model };
  }
}
