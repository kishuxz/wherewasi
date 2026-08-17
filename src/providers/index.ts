import { AnthropicProvider } from "./anthropic.js";
import { GroqProvider } from "./groq.js";
import type { Provider, ProviderName } from "./types.js";

export * from "./types.js";
export { GroqProvider, GROQ_DEFAULT_MODEL, GROQ_DEFAULT_BASE_URL } from "./groq.js";
export { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "./anthropic.js";

export type ProviderEnv = Record<string, string | undefined>;

export interface Selection {
  provider: Provider | null;
  /** Populated when no provider could be built; shown to the user verbatim. */
  reason: string | null;
}

function requested(env: ProviderEnv): ProviderName | null {
  const raw = env["WHEREWASI_PROVIDER"]?.trim().toLowerCase();
  if (raw === "groq" || raw === "anthropic") return raw;
  return null;
}

/**
 * Groq is the default because it is reachable on a free tier. Anthropic is used
 * when it is the only key present, or when explicitly asked for.
 */
export function selectProvider(env: ProviderEnv = process.env): Selection {
  const groqKey = env["GROQ_API_KEY"]?.trim();
  const anthropicKey = env["ANTHROPIC_API_KEY"]?.trim();
  const explicit = requested(env);

  if (explicit === "anthropic") {
    if (!anthropicKey) {
      return {
        provider: null,
        reason: "WHEREWASI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set",
      };
    }
    return {
      provider: new AnthropicProvider({
        apiKey: anthropicKey,
        model: env["ANTHROPIC_MODEL"] ?? "",
      }),
      reason: null,
    };
  }

  if (explicit === "groq") {
    if (!groqKey) {
      return { provider: null, reason: "WHEREWASI_PROVIDER=groq but GROQ_API_KEY is not set" };
    }
    return { provider: buildGroq(groqKey, env), reason: null };
  }

  if (groqKey) return { provider: buildGroq(groqKey, env), reason: null };

  if (anthropicKey) {
    return {
      provider: new AnthropicProvider({
        apiKey: anthropicKey,
        model: env["ANTHROPIC_MODEL"] ?? "",
      }),
      reason: null,
    };
  }

  return { provider: null, reason: "no API key set (GROQ_API_KEY or ANTHROPIC_API_KEY)" };
}

function buildGroq(apiKey: string, env: ProviderEnv): Provider {
  return new GroqProvider({
    apiKey,
    model: env["GROQ_MODEL"] ?? "",
    baseUrl: env["GROQ_BASE_URL"] ?? "",
  });
}
