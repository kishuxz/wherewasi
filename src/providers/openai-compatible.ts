import { ProviderError } from "./types.js";
import type { Provider, ProviderRequest, ProviderResult } from "./types.js";

/**
 * One client for every vendor that speaks OpenAI chat-completions: Groq,
 * OpenAI, Together, OpenRouter, DeepSeek, Fireworks, and a local Ollama. The
 * only thing that varies between them is a base URL and a model id, so those
 * are configuration rather than code.
 */

export const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Chosen by listing GET /models on a live free tier rather than from memory: a
 * 120B reasoning-tuned MoE, and the fastest of the reasoning-capable models
 * there. Override with WHEREWASI_MODEL for any other endpoint.
 */
export const DEFAULT_MODEL = "openai/gpt-oss-120b";

const TIMEOUT_MS = 30_000;

const TRUNCATED_COMPLETION =
  "the model ran out of output budget mid-answer (raise MAX_TOKENS or shorten the input)";

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string; type?: string };
}

/** True for a base URL served from this machine — used to relax the key requirement. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

export class OpenAICompatibleProvider implements Provider {
  readonly name = "openai-compatible" as const;
  readonly model: string;
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model || DEFAULT_MODEL;
    // Ollama and friends ignore the header but still expect one to be present.
    this.apiKey = opts.apiKey || (isLocalEndpoint(this.baseUrl) ? "local" : "");
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
          response_format: { type: "json_object" },
          max_completion_tokens: req.maxTokens,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`could not reach ${this.baseUrl} (${message})`, "network");
    }

    const raw = await response.text();
    let body: ChatCompletionResponse = {};
    try {
      body = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      // A non-JSON body is only interesting for its status code.
    }

    if (!response.ok) {
      const detail = body.error?.message ?? raw.slice(0, 200);
      if (response.status === 429) {
        throw new ProviderError(`rate limit reached (${detail})`, "rate_limit", response.status);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(`the API key was rejected (${detail})`, "auth", response.status);
      }
      throw new ProviderError(
        `${this.baseUrl} returned ${response.status} (${detail})`,
        "http",
        response.status,
      );
    }

    const choice = body.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (!text.trim()) {
      throw new ProviderError("the model returned an empty completion", "http", response.status);
    }
    if (choice?.finish_reason === "length") {
      throw new ProviderError(TRUNCATED_COMPLETION, "http", response.status);
    }

    return { text, model: body.model ?? this.model };
  }
}
